/**
 * Corveno corpus runner — seed refresh + ATS board poll + registry verify.
 * Usage: node dist/run.cjs <seed|poll|verify>
 *
 * Full primary source descriptions and changed source snapshots are retained
 * for every role. Source checks use complete validated board snapshots, with
 * atomic generation-bound, change-only, batch-indexed writes and conservative
 * two-snapshot closure.
 *
 * Data sources gratefully consumed (see README attribution):
 * SimplifyJobs lists, vanshb03 lists, jobhive/ats-scrapers registry,
 * and the public Greenhouse / Lever / Ashby job board APIs.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import {
  fetchPrimaryBoard,
  boundedJson,
  CollectionError,
  type PrimaryAts,
} from "./primary-source";
import { employmentTypeEvidence } from "./employment-evidence";
import { gazetteerCountryEvidence, combineCountryEvidence } from "./location-gazetteer";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const CONCURRENCY = 8;
/* Bounded pilot / rollout controls (GitHub workflow inputs → env).
 * COLLECT_BOARD_LIMIT: max boards this run (0 = all); COLLECT_ATS: one ATS or
 * "all"; COLLECT_TIER: one registry tier or "all"; COLLECT_PILOT=1 prints a
 * per-run measurement summary (payload bytes, description sizes, typed/country
 * coverage, DB time) for the rollout cost review. */
const BOARD_LIMIT = Math.max(0, Number(process.env.COLLECT_BOARD_LIMIT ?? 0) || 0);
const ATS_FILTER = (process.env.COLLECT_ATS ?? "all").toLowerCase();
const TIER_FILTER = (process.env.COLLECT_TIER ?? "all").toLowerCase();
const PILOT = process.env.COLLECT_PILOT === "1";
/* Write batch bounds. Measured Sep 15 pilot: ~40KB source JSON per posting and
 * ~7s per 100-row batch on the current compute, so default to ~25 rows / 1MiB. */
const BATCH_MAX_ROWS = Math.min(100, Math.max(1, Number(process.env.COLLECT_BATCH_ROWS ?? 50) || 50));
/* Owner decision (Sep 15, 2026): complete description text, structured facts,
 * evidence and the content hash are stored for every listing; the raw provider
 * record is only stored when explicitly requested (pilot measurements). The
 * runtime captures raw records on demand for listings a search touches. */
const STORE_SNAPSHOTS = process.env.COLLECT_STORE_SNAPSHOTS === "1";
const BATCH_MAX_BYTES = Math.min(8 * 1024 * 1024, Math.max(65536, Number(process.env.COLLECT_BATCH_BYTES ?? 1048576) || 1048576));
/* ---------------- classification ---------------- */

const INTERN_RE = /\bintern(ship)?s?\b|\bco[- ]?op\b|\bapprentice(ship)?\b/i;
const NEWGRAD_RE =
  /\bnew ?grad(uate)?\b|\buniversity grad(uate)?\b|\brecent grad(uate)?\b|\bcampus hire\b|\bgraduate (program|scheme|engineer|analyst)\b|\bclass of 20\d\d\b|\bearly career\b/i;
const TERM_RE = /\b(summer|fall|spring|winter)\s*'?(20)?(2[5-9])\b/gi;
const GRAD_RE =
  /\b(?:class of|graduating(?: in| by)?|expected graduation[:\s]*)\s*(20\d\d)\b/i;
const SPONSOR_NO_RE =
  /not (?:able to )?sponsor|unable to sponsor|without (?:the need for )?sponsorship|no sponsorship|sponsorship is not available/i;
const SPONSOR_CIT_RE =
  /u\.?s\.? citizen(ship)?(?: is)? required|citizens? only/i;
const SPONSOR_YES_RE =
  /sponsorship (?:is )?available|will sponsor|able to sponsor/i;

function classify(
  title: string,
  structuredType: string | null,
  description: string | null,
) {
  let kind: "intern" | "new_grad" | "other" = "other";
  let source = "regex";
  if (structuredType === "internship") {
    kind = "intern";
    source = "structured";
  } else if (INTERN_RE.test(title)) kind = "intern";
  else if (NEWGRAD_RE.test(title)) kind = "new_grad";

  const terms: string[] = [];
  for (const m of title.matchAll(TERM_RE)) {
    const t = `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[3].length === 2 ? "20" + m[3] : m[3]}`;
    if (!terms.includes(t)) terms.push(t);
  }
  const gm =
    title.match(GRAD_RE) ?? description?.slice(0, 4000)?.match(GRAD_RE) ?? null;
  const grad_year = gm ? parseInt(gm[1], 10) : null;

  let sponsorship = "unknown";
  if (description) {
    const tail =
      description.length > 8000 ? description.slice(-6000) : description;
    if (SPONSOR_CIT_RE.test(tail)) sponsorship = "citizenship_required";
    else if (SPONSOR_NO_RE.test(tail)) sponsorship = "no";
    else if (SPONSOR_YES_RE.test(tail)) sponsorship = "offers";
  }
  return { kind, terms, grad_year, sponsorship, classify_source: source };
}

// Postgres rejects \x00 in TEXT/JSONB; some boards ship it. Scrub every
// string that touches the database.
function clean(s: unknown): string {
  const str = String(s ?? "");
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0) continue; // NUL breaks Postgres TEXT/JSONB
    if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate: keep only as a complete pair
      const n = str.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += str[i] + str[i + 1];
        i++;
      }
      continue; // lone high surrogate dropped (JSON-invalid)
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue; // lone low surrogate dropped
    out += c < 32 && c !== 9 && c !== 10 && c !== 13 ? " " : str[i];
  }
  return out;
}

// Truncate without splitting a surrogate pair (which would re-poison JSON).
function cut(s: string, n: number): string {
  let t = s.slice(0, n);
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t;
}

/* ---------------- shared helpers ---------------- */

// Keyset pagination on the id PK: offset pagination over 300k+ rows hits the
// Postgres statement timeout; cursoring on an indexed column stays fast at any
// depth. Every caller's select must include "id".
async function pageAll<T extends Record<string, unknown>>(
  table: string,
  select: string,
  filter?: (q: any) => any,
  // Keyset column. Must be unique within the filtered set and served by an
  // index together with the filter: a source-scoped corpus read orders by
  // source_uid (UNIQUE(source, source_uid)); ordering by id there made the
  // planner walk the whole wide corpus in id order (statement timeout).
  orderBy = "id",
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    let q = supabase
      .from(table)
      .select(select)
      .order(orderBy, { ascending: true })
      .limit(1000);
    if (cursor) q = q.gt(orderBy, cursor);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
    cursor = String(rows[rows.length - 1][orderBy]);
  }
  return out;
}

// Wide corpus rows (full descriptions, a dozen indexes, discovery trigger)
// are expensive to rewrite: keep batches small and split a batch that hits
// the statement timeout (57014) instead of failing the whole source.
const UPSERT_BATCH = 100;
async function upsertSplit(
  table: string,
  rows: Record<string, unknown>[],
  conflict: string,
  label: string,
  offset: number,
): Promise<void> {
  const { error } = await supabase
    .from(table)
    .upsert(rows, { onConflict: conflict });
  if (!error) return;
  if (error.code === "57014" && rows.length > 10) {
    const half = Math.ceil(rows.length / 2);
    await upsertSplit(table, rows.slice(0, half), conflict, label, offset);
    await upsertSplit(table, rows.slice(half), conflict, label, offset + half);
    return;
  }
  throw new Error(`${label} @${offset}: ${error.message}`);
}
async function upsertBatches(
  table: string,
  rows: Record<string, unknown>[],
  conflict: string,
  label: string,
) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await upsertSplit(table, rows.slice(i, i + UPSERT_BATCH), conflict, label, i);
    if (i % 5000 === 0)
      process.stdout.write(
        `\r${label}: ${Math.min(i + UPSERT_BATCH, rows.length)}/${rows.length}`,
      );
  }
  if (rows.length) console.log(`\r${label}: ${rows.length}/${rows.length}`);
}

/* ---------------- seed refresh ---------------- */

const SEEDS = [
  {
    url: "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    source: "simplify-intern",
    kind: "intern",
  },
  {
    url: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
    source: "simplify-newgrad",
    kind: "new_grad",
  },
  {
    url: "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json",
    source: "vansh-intern",
    kind: "intern",
  },
] as const;

const SPONSOR_MAP: Record<string, string> = {
  "Offers Sponsorship": "offers",
  "Does Not Offer Sponsorship": "no",
  "U.S. Citizenship is Required": "citizenship_required",
};

function epochToIso(v?: number): string | null {
  if (!v || v <= 0) return null;
  const d = new Date(v > 1e12 ? v : v * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function seed() {
  for (const s of SEEDS) {
    let listings;
    try {
      listings = await boundedJson(s.url, fetch, 25165824, 30000, true);
    } catch {
      console.warn(`${s.source}: source unavailable — skipped`);
      continue;
    }
    if (
      !Array.isArray(listings) ||
      listings.some(
        (l) =>
          !l ||
          typeof l.id !== "string" ||
          !l.id ||
          typeof l.url !== "string" ||
          !l.url ||
          typeof l.company_name !== "string" ||
          !l.company_name ||
          typeof l.title !== "string" ||
          !l.title,
      )
    ) {
      console.warn(`${s.source}: incomplete or malformed source — skipped`);
      continue;
    }
    const checkedAt = new Date().toISOString();
    // Change-only writes, like the board collector: a row is rewritten only
    // when its seed content hash differs; unchanged rows get a presence
    // re-stamp at most every six hours (two narrow columns, no wide rewrite).
    const prior = new Map(
      (
        await pageAll<{
          id: string;
          source_uid: string;
          posted_at: string | null;
          source_content_sha256: string | null;
          last_seen_at: string | null;
        }>(
          "corpus_listings",
          "id,source_uid,posted_at,source_content_sha256,last_seen_at",
          (q) => q.eq("source", s.source),
          "source_uid",
        )
      ).map((row) => [row.source_uid, row]),
    );
    const rows: Record<string, unknown>[] = [];
    const restamp: string[] = [];
    // Presence re-stamp of unchanged seed rows once a day: every re-stamp
    // rewrites a wide corpus row plus its indexes, and 35k community-list rows
    // at six-hour cadence saturated the small instance on September 15, 2026.
    const restampBefore = Date.now() - 24 * 3600 * 1000;
    let unchanged = 0;
    for (const l of listings) {
      if (!l.id || !l.url || !l.company_name || !l.title) continue;
      const active = l.active !== false;
      const previous = prior.get(l.id);
      const content = {
        company_name: cut(clean(l.company_name), 200),
        title: cut(clean(l.title), 300),
        canonical_url: cut(clean(l.url), 800),
        locations: (l.locations ?? []).map((x: unknown) => cut(clean(x), 120)),
        kind: s.kind,
        terms: l.terms ?? (l.season ? [l.season] : []),
        sponsorship: SPONSOR_MAP[l.sponsorship ?? ""] ?? "unknown",
        status: active ? "active" : "closed",
        posted_at: previous?.posted_at ?? epochToIso(l.date_posted),
        updated_at_source: epochToIso(l.date_updated),
        closed_at: active ? null : epochToIso(l.date_updated),
        is_publicly_listed: l.is_visible !== false,
      };
      const sha = createHash("sha256")
        .update(JSON.stringify(content))
        .digest("hex");
      if (previous && previous.source_content_sha256 === sha) {
        unchanged++;
        const seen = previous.last_seen_at ? Date.parse(previous.last_seen_at) : 0;
        if (!(seen > restampBefore)) restamp.push(previous.id);
        continue;
      }
      rows.push({
        source: s.source,
        source_uid: l.id,
        ...content,
        classify_source: "seed",
        source_content_sha256: sha,
        source_checked_at: checkedAt,
        last_seen_at: checkedAt,
      });
    }
    await upsertBatches("corpus_listings", rows, "source,source_uid", s.source);
    for (let i = 0; i < restamp.length; i += 100) {
      const { error } = await supabase
        .from("corpus_listings")
        .update({ last_seen_at: checkedAt, source_checked_at: checkedAt })
        .in("id", restamp.slice(i, i + 100));
      if (error) throw new Error(`${s.source} re-stamp @${i}: ${error.message}`);
    }
    console.log(
      `${s.source}: ${rows.length} written, ${unchanged} unchanged, ${restamp.length} re-stamped`,
    );
  }
}

/* ---------------- board poll ---------------- */

async function poll() {
  // Board-scoped reads/writes use indexed keys. Never load the entire corpus
  // into process memory or infer closure for boards not successfully polled.
  const boards = await pageAll<{
    id: string;
    name: string;
    ats: PrimaryAts;
    board_token: string;
    board_url: string | null;
    tier: string;
  }>("ats_companies", "id,name,ats,board_token,board_url,tier", (q) =>
    q
      .in("ats", ["greenhouse", "lever", "ashby"])
      .in("verify_status", ["active", "empty"]),
  );
  boards.sort(
    (a, b) =>
      Number(b.tier === "intern-proven") - Number(a.tier === "intern-proven"),
  );
  let selected = boards.filter(
    (b) =>
      (ATS_FILTER === "all" || b.ats === ATS_FILTER) &&
      (TIER_FILTER === "all" || b.tier === TIER_FILTER),
  );
  if (BOARD_LIMIT > 0) selected = selected.slice(0, BOARD_LIMIT);
  console.log(
    `boards: ${selected.length} selected of ${boards.length} (ats=${ATS_FILTER}, tier=${TIER_FILTER}, limit=${BOARD_LIMIT || "none"})`,
  );
  const queue = [...selected],
    stats = { completed: 0, failed: 0, postings: 0 },
    measure = {
      sourceBytes: 0,
      descriptionChars: 0,
      withDescription: 0,
      typed: 0,
      typedFromStructured: 0,
      typedFromText: 0,
      withCountry: 0,
      countryFromGazetteer: 0,
      batches: 0,
      splits: 0,
      skippedMalformed: 0,
      written: 0,
      unchanged: 0,
      bumped: 0,
      fetchMs: 0,
      dbMs: 0,
      failures: {} as Record<string, number>,
    };
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await supabase.rpc(name, args);
    if (error)
      throw new CollectionError(`DATABASE_${error.code ?? "UNAVAILABLE"}`);
    return data;
  }
  const worker = async () => {
    for (;;) {
      const board = queue.shift();
      if (!board) return;
      const runId = randomUUID();
      let started = false;
      try {
        await rpc("begin_corpus_collection", {
          p_company_id: board.id,
          p_run_id: runId,
        });
        started = true;
        const eu =
          board.ats === "lever" &&
          Boolean(
            board.board_url &&
              new URL(board.board_url).hostname === "jobs.eu.lever.co",
          );
        const fetchStart = Date.now();
        const snapshot = await fetchPrimaryBoard(
          board.ats,
          board.board_token,
          fetch,
          eu,
        );
        measure.fetchMs += Date.now() - fetchStart;
        if (snapshot.skippedMalformed) {
          measure.skippedMalformed += snapshot.skippedMalformed;
          console.warn("Skipped malformed source records", { boardId: board.id, source: board.ats, count: snapshot.skippedMalformed });
        }
        const rows = snapshot.jobs.map((job) => {
          // Source-stated employment type: the provider's structured field, or
          // an explicit statement in the title/description with its quote.
          // Unknown stays null; a contradiction is recorded, not resolved.
          const preliminary = classify(job.title, job.structured_job_type, job.description);
          const employment = employmentTypeEvidence({
            title: job.title,
            description: job.description,
            structured: job.structured_job_type,
            kind: preliminary.kind,
          });
          const structured_job_type =
            job.structured_job_type ??
            (employment.conflict ? null : employment.type);
          // Country: structured provider fields and explicit country labels
          // (primary-source) first; otherwise the conservative seven-market
          // gazetteer (unambiguous city/region names only, never a guess).
          let country_codes = job.country_codes;
          let country_evidence = job.country_evidence;
          if (!country_codes.length && job.locations.length) {
            const gazetteer = gazetteerCountryEvidence(job.locations.join(" ; "));
            const combined = combineCountryEvidence(job.country_codes, gazetteer);
            if (combined.length) {
              country_codes = combined;
              country_evidence = {
                ...country_evidence,
                gazetteer: gazetteer.matches,
                gazetteer_ambiguous: gazetteer.ambiguous,
                country_method: "gazetteer",
              };
            } else if (gazetteer.ambiguous.length || gazetteer.conflict) {
              country_evidence = { ...country_evidence, gazetteer_ambiguous: gazetteer.ambiguous, gazetteer_conflict: gazetteer.conflict };
            }
          }
          const { source_record_json, ...withoutRaw } = job;
          return {
            ...(STORE_SNAPSHOTS ? job : withoutRaw),
            country_codes,
            country_evidence,
            structured_job_type,
            employment_evidence: employment.items,
            ...classify(job.title, structured_job_type, job.description),
            // Kept for pilot measurement only; not sent unless stored.
            __sourceBytes: Buffer.byteLength(source_record_json, "utf8"),
          };
        });
        if (PILOT)
          for (const row of rows) {
            measure.sourceBytes += row.__sourceBytes;
            measure.descriptionChars += row.description?.length ?? 0;
            if (row.description) measure.withDescription++;
            if (row.structured_job_type) {
              measure.typed++;
              if (row.employment_evidence.some((i) => i.field === "structured")) measure.typedFromStructured++;
              else measure.typedFromText++;
            }
            if (row.country_codes.length) measure.withCountry++;
            if (row.country_evidence.country_method === "gazetteer") measure.countryFromGazetteer++;
          }
        // Batches carry a 0-based sequential index. The database records the
        // applied indexes per run, so a retransmitted batch (timeout, retry)
        // is a no-op and received_count stays the sum of distinct batches.
        // Present rows whose saved content and metadata are unchanged are
        // not rewritten server-side (change-only writes).
        // Batches are bounded by bytes as well as rows: full-content rows
        // average ~40KB, and every supabase-js statement has an 8-second
        // timeout on the current compute. A batch that still times out
        // (57014) is split in halves under fresh indexes; a timed-out
        // statement rolled back entirely, so nothing is double-applied.
        let batchIndex = 0;
        const applyRows = async (slice: typeof rows): Promise<void> => {
          const index = batchIndex++;
          const dbStart = Date.now();
          try {
            const applied = (await rpc("apply_corpus_collection_batch", {
              p_run_id: runId,
              p_checked_at: snapshot.checkedAt,
              p_source_url: snapshot.sourceUrl,
              p_rows: slice.map(({ __sourceBytes: _ignored, ...row }) => row),
              p_batch_index: index,
            })) as { written?: number; unchanged?: number; bumped?: number } | null;
            measure.dbMs += Date.now() - dbStart;
            measure.batches++;
            measure.written += applied?.written ?? 0;
            measure.unchanged += applied?.unchanged ?? 0;
            measure.bumped += applied?.bumped ?? 0;
          } catch (error) {
            measure.dbMs += Date.now() - dbStart;
            if (
              error instanceof CollectionError &&
              error.code === "DATABASE_57014" &&
              slice.length > 1
            ) {
              measure.splits++;
              const half = Math.ceil(slice.length / 2);
              await applyRows(slice.slice(0, half));
              await applyRows(slice.slice(half));
              return;
            }
            throw error;
          }
        };
        for (let offset = 0; offset < rows.length; ) {
          let end = offset,
            total = 0;
          while (end < rows.length && end - offset < BATCH_MAX_ROWS) {
            const { __sourceBytes: _ignored, ...row } = rows[end];
            const size = Buffer.byteLength(JSON.stringify(row), "utf8");
            if (total + size > BATCH_MAX_BYTES && end > offset) break;
            total += size;
            end++;
          }
          await applyRows(rows.slice(offset, end));
          offset = end;
        }
        const finishStart = Date.now();
        await rpc("finish_corpus_collection", {
          p_run_id: runId,
          p_expected_count: rows.length,
          p_checked_at: snapshot.checkedAt,
          p_source_url: snapshot.sourceUrl,
          p_error_code: null,
        });
        measure.dbMs += Date.now() - finishStart;
        stats.completed++;
        stats.postings += rows.length;
        if ((stats.completed + stats.failed) % 250 === 0)
          console.log(
            `boards:${stats.completed + stats.failed}/${selected.length} postings:${stats.postings} failed:${stats.failed}`,
          );
      } catch (error) {
        stats.failed++;
        const code =
          error instanceof CollectionError
            ? error.code
            : "COLLECTION_UNAVAILABLE";
        measure.failures[code] = (measure.failures[code] ?? 0) + 1;
        console.warn("Board collection failed", {
          boardId: board.id,
          source: board.ats,
          code,
        });
        if (started)
          try {
            await rpc("finish_corpus_collection", {
              p_run_id: runId,
              p_expected_count: null,
              p_checked_at: null,
              p_source_url: null,
              p_error_code: code,
            });
          } catch {
            console.warn("Board failure could not be recorded", {
              boardId: board.id,
            });
          }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log("Collection complete", stats);
  if (PILOT)
    console.log(
      "PILOT_SUMMARY " +
        JSON.stringify({
          ...stats,
          ...measure,
          avgSourceBytes: stats.postings ? Math.round(measure.sourceBytes / stats.postings) : 0,
          avgDescriptionChars: stats.postings ? Math.round(measure.descriptionChars / stats.postings) : 0,
        }),
    );
  // Board-level failures are recorded per board (last_poll_status='error',
  // consecutive_failures) and retried next cycle; the run itself fails only
  // when more than a small share of boards failed, which signals a systemic
  // problem (provider outage, database timeouts, schema mismatch).
  const tolerated = Math.max(3, Math.floor(selected.length * 0.05));
  if (stats.failed > tolerated) {
    console.error(`Run failed: ${stats.failed} boards failed (tolerated ${tolerated})`);
    process.exitCode = 1;
  } else if (stats.failed) {
    console.warn(`${stats.failed} board(s) failed and will be retried next cycle`);
  }
}

/* ---------------- registry verify (weekly) ---------------- */

async function verify() {
  const companies = await pageAll<{
    id: string;
    ats: string;
    board_token: string;
    board_url: string | null;
  }>("ats_companies", "id, ats, board_token, board_url, tier");
  console.log(`verifying ${companies.length} boards…`);
  const counts = { active: 0, empty: 0, unknown: 0 };
  let done = 0;
  const queue = [...companies];
  const worker = async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const status = await probe(c.ats, c.board_token, c.board_url);
      counts[status]++;
      if (status !== "unknown") {
        const { error } = await supabase
          .from("ats_companies")
          .update({
            verify_status: status,
            last_verified_at: new Date().toISOString(),
          })
          .eq("id", c.id);
        if (error) throw new CollectionError("VERIFY_WRITE_FAILED");
      }
      if (++done % 500 === 0)
        process.stdout.write(`\r${done}/${companies.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(
    `\nDONE — active:${counts.active} empty:${counts.empty} unknown:${counts.unknown}`,
  );
}

async function probe(
  ats: string,
  slug: string,
  registryUrl: string | null,
): Promise<"active" | "empty" | "unknown"> {
  if (!["greenhouse", "lever", "ashby"].includes(ats)) return "unknown";
  try {
    const eu =
      ats === "lever" &&
      Boolean(
        registryUrl && new URL(registryUrl).hostname === "jobs.eu.lever.co",
      );
    const result = await fetchPrimaryBoard(ats as PrimaryAts, slug, fetch, eu);
    return result.jobs.length ? "active" : "empty";
  } catch {
    return "unknown";
  }
}

/* ---------------- entry ---------------- */

const mode = process.argv[2];
const run =
  mode === "seed"
    ? seed
    : mode === "verify"
      ? verify
      : mode === "poll"
        ? poll
        : null;
if (!run) {
  console.error("usage: node dist/run.cjs <seed|poll|verify>");
  process.exit(1);
}
run().catch((e) => {
  console.error(`${mode} FAILED:`, e);
  process.exit(1);
});
