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
 * the public Greenhouse / Lever / Ashby job board APIs, the Recruitee /
 * Workable / Breezy / Pinpoint / Teamtailor career-site feeds and the USAJOBS
 * Search API (credited as the source wherever its announcements are shown).
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import {
  fetchPrimaryBoard,
  boundedJson,
  usajobsCredentials,
  isPrimaryAts,
  CollectionError,
  PRIMARY_ATS,
  type PrimaryAts,
} from "./primary-source";
import { employmentTypeEvidence } from "./employment-evidence";
import { resolveLocationCountries, locationCountryEvidenceFields } from "./location-country";
import {
  claimSources,
  createClaimQueue,
  isMissingRpc,
  passRunKey,
  shardSources,
  type ClaimQueueStats,
} from "./board-scheduling";

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
/* Scheduled polling (Phase 1 item 1.4, migration 20260917120000). A pass no
 * longer fetches every board: it claims due boards in fairness-ordered batches
 * (claim_due_boards, lease owner = the pass run key) up to a per-pass board
 * cap and a wall-time budget for claiming, and reports each board's outcome
 * (finish_board_poll) so its next due time follows its change rate.
 * COLLECT_ATS_SHARD partitions the registry across parallel workflow jobs:
 * greenhouse | lever | ashby | others | all, or a comma-separated list. */
const BOARD_CAP = Math.max(1, Math.floor(Number(process.env.COLLECT_BOARD_CAP ?? 4000) || 4000));
const PASS_BUDGET_SECONDS = Math.max(30, Number(process.env.COLLECT_PASS_BUDGET_SECONDS ?? 900) || 900);
const LEASE_SECONDS = Math.min(14400, Math.max(60, Math.floor(Number(process.env.COLLECT_LEASE_SECONDS ?? 1800) || 1800)));
const CLAIM_BATCH = Math.min(500, Math.max(8, Math.floor(Number(process.env.COLLECT_CLAIM_BATCH ?? 64) || 64)));
const ATS_SHARD = (process.env.COLLECT_ATS_SHARD ?? "all").toLowerCase();
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
          corpus_listing_presence: { last_seen_at: string } | null;
        }>(
          "corpus_listings",
          "id,source_uid,posted_at,source_content_sha256,last_seen_at,corpus_listing_presence(last_seen_at)",
          (q) => q.eq("source", s.source),
          "source_uid",
        )
      ).map((row) => [row.source_uid, row]),
    );
    const rows: Record<string, unknown>[] = [];
    const restamp: string[] = [];
    // Presence re-stamps of unchanged seed rows go to the narrow
    // corpus_listing_presence table (20260915130000), at most every six hours,
    // never rewriting the wide corpus row.
    const restampBase = Date.now() - 6 * 3600 * 1000;
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
        const seen = Math.max(
          previous.last_seen_at ? Date.parse(previous.last_seen_at) : 0,
          previous.corpus_listing_presence?.last_seen_at
            ? Date.parse(previous.corpus_listing_presence.last_seen_at)
            : 0,
        );
        if (!(seen > restampBase)) restamp.push(previous.id);
        continue;
      }
      // Seed lists carry no structured country; the same label resolver the
      // board collector uses fills it in (quote and method recorded). The
      // country stays outside the content hash so unchanged rows are not
      // rewritten for it — the recountry mode backfills those.
      const country = resolveLocationCountries(content.locations);
      rows.push({
        source: s.source,
        source_uid: l.id,
        ...content,
        country_codes: country.countries,
        country_evidence: { source: "seed-list", ...locationCountryEvidenceFields(country) },
        classify_source: "seed",
        source_content_sha256: sha,
        source_checked_at: checkedAt,
        last_seen_at: checkedAt,
      });
    }
    await upsertBatches("corpus_listings", rows, "source,source_uid", s.source);
    for (let i = 0; i < restamp.length; i += 500) {
      const { error } = await supabase.from("corpus_listing_presence").upsert(
        restamp.slice(i, i + 500).map((id) => ({
          listing_id: id,
          last_seen_at: checkedAt,
          source_checked_at: checkedAt,
        })),
        { onConflict: "listing_id" },
      );
      if (error) throw new Error(`${s.source} re-stamp @${i}: ${error.message}`);
    }
    console.log(
      `${s.source}: ${rows.length} written, ${unchanged} unchanged, ${restamp.length} re-stamped`,
    );
  }
}

/* ---------------- board poll ---------------- */

type Board = {
  id: string;
  name: string;
  ats: PrimaryAts;
  board_token: string;
  board_url: string | null;
  tier: string;
};
const BOARD_COLUMNS = "id,name,ats,board_token,board_url,tier";
type SourceTally = { boards: number; failed: number; written: number; closed: number; missed: number };

async function poll() {
  const startedAt = new Date();
  // USAJOBS needs the account holder's registered key (USAJOBS_API_KEY) and
  // registered e-mail (USAJOBS_USER_AGENT). Without them its boards are
  // skipped for this run — never leased, never counted as failures.
  const usajobs = usajobsCredentials();
  const runKey = passRunKey(process.env, ATS_SHARD, randomUUID);
  const sources = claimSources({ shard: ATS_SHARD, atsFilter: ATS_FILTER, all: PRIMARY_ATS, usajobs: Boolean(usajobs) });
  if (!usajobs && shardSources(ATS_SHARD, PRIMARY_ATS).includes("usajobs") && (ATS_FILTER === "all" || ATS_FILTER === "usajobs"))
    console.warn("usajobs: boards skipped — USAJOBS_API_KEY and USAJOBS_USER_AGENT are not set");
  const cap = BOARD_LIMIT > 0 ? Math.min(BOARD_LIMIT, BOARD_CAP) : BOARD_CAP;
  console.log(
    `pass ${runKey}: shard=${ATS_SHARD} sources=${sources.join(",") || "none"} ats=${ATS_FILTER} tier=${TIER_FILTER} cap=${cap} budget=${PASS_BUDGET_SECONDS}s lease=${LEASE_SECONDS}s batch=${CLAIM_BATCH}`,
  );
  if (!sources.length) {
    console.log("boards: nothing to claim for this shard/filter");
    return;
  }
  // Scheduled selection: claim_due_boards leases due boards in fairness order
  // (round-robin across sources; overdue > 2 h, intern-proven, change rate,
  // most overdue inside a source) and the pass reports every outcome through
  // finish_board_poll. Legacy selection — every active/empty board,
  // intern-proven first, no leases, no schedule updates — remains for a pilot
  // with a tier filter (a measurement, not a schedule) and for a database
  // without the RPCs (migration not yet applied), with a warning instead of a
  // failed pass. Board-scoped reads/writes use indexed keys either way; the
  // corpus is never loaded into process memory.
  const claim = async (limit: number): Promise<Board[]> => {
    const { data, error } = await supabase.rpc("claim_due_boards", {
      p_limit: limit,
      p_lease_seconds: LEASE_SECONDS,
      p_owner: runKey,
      p_ats: sources.join(","),
    });
    if (error) throw Object.assign(new Error(`claim_due_boards: ${error.message}`), { code: error.code });
    return ((data ?? []) as Board[]).filter((b) => isPrimaryAts(b.ats));
  };
  let scheduled = TIER_FILTER === "all";
  let initial: Board[] = [];
  if (scheduled) {
    try {
      initial = await claim(Math.min(CLAIM_BATCH, cap));
    } catch (error) {
      if (!isMissingRpc(error as { code?: string; message?: string })) throw error;
      scheduled = false;
      console.warn(
        "claim_due_boards is not available (migration 20260917120000 not applied) — polling every active/empty board this pass without leases",
      );
    }
  } else console.log(`tier filter ${TIER_FILTER}: legacy selection without leases or schedule updates`);
  let next: () => Promise<Board | null>;
  let queueStats: () => ClaimQueueStats;
  if (scheduled) {
    const claimQueue = createClaimQueue<Board>({ claim, cap, budgetMs: PASS_BUDGET_SECONDS * 1000, batch: CLAIM_BATCH, initial });
    next = claimQueue.next;
    queueStats = claimQueue.stats;
  } else {
    const boards = await pageAll<Board>("ats_companies", BOARD_COLUMNS, (q) =>
      q.in("ats", sources).in("verify_status", ["active", "empty"]),
    );
    boards.sort((a, b) => Number(b.tier === "intern-proven") - Number(a.tier === "intern-proven"));
    let selected = boards.filter((b) => TIER_FILTER === "all" || b.tier === TIER_FILTER);
    if (BOARD_LIMIT > 0) selected = selected.slice(0, BOARD_LIMIT);
    console.log(`boards: ${selected.length} selected of ${boards.length} (legacy selection, limit=${BOARD_LIMIT || "none"})`);
    const legacyStart = Date.now();
    const legacyQueue = [...selected];
    next = async () => legacyQueue.shift() ?? null;
    queueStats = () => ({ claimed: selected.length, claims: 0, stoppedBy: null, error: null, elapsedMs: Date.now() - legacyStart });
  }
  const perSource: Record<string, SourceTally> = {};
  let scheduleErrors = 0;
  const stats = { completed: 0, failed: 0, postings: 0 },
    measure = {
      sourceBytes: 0,
      descriptionChars: 0,
      withDescription: 0,
      typed: 0,
      typedFromStructured: 0,
      typedFromText: 0,
      withCountry: 0,
      countryFromGazetteer: 0,
      countryFromLabels: 0,
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
      const board = await next();
      if (!board) return;
      const runId = randomUUID();
      const tally = (perSource[board.ats] ??= { boards: 0, failed: 0, written: 0, closed: 0, missed: 0 });
      tally.boards++;
      // Per-board outcome for the schedule: "changed" when this pass wrote
      // new/updated/reopened rows (apply batches), closed rows or recorded a
      // first miss (finish) — a board that just lost a posting is polled again
      // soon so the closure lands on the next complete snapshot.
      let started = false,
        written = 0,
        closed = 0,
        missed = 0,
        failed = false;
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
          usajobs,
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
          // (primary-source) first; otherwise the deterministic location-label
          // resolver (location-country: explicit and remote-scoped labels, the
          // seven-market gazetteer, explicit non-market country names and
          // unambiguous world cities — every country carries its quote, never
          // a guess). Regions, "Remote" alone and ambiguous names stay empty
          // and are recorded as such.
          let country_codes = job.country_codes;
          let country_evidence = job.country_evidence;
          if (!country_codes.length && job.locations.length) {
            const resolved = resolveLocationCountries(job.locations);
            if (resolved.countries.length) country_codes = resolved.countries;
            country_evidence = { ...country_evidence, ...locationCountryEvidenceFields(resolved) };
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
            if (row.country_evidence.location_evidence) measure.countryFromLabels++;
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
            written += applied?.written ?? 0;
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
        const finished = (await rpc("finish_corpus_collection", {
          p_run_id: runId,
          p_expected_count: rows.length,
          p_checked_at: snapshot.checkedAt,
          p_source_url: snapshot.sourceUrl,
          p_error_code: null,
        })) as { closed?: number; firstMiss?: number } | null;
        measure.dbMs += Date.now() - finishStart;
        closed = finished?.closed ?? 0;
        missed = finished?.firstMiss ?? 0;
        stats.completed++;
        stats.postings += rows.length;
        tally.written += written;
        tally.closed += closed;
        tally.missed += missed;
        if ((stats.completed + stats.failed) % 250 === 0)
          console.log(
            `boards:${stats.completed + stats.failed}/${queueStats().claimed} postings:${stats.postings} failed:${stats.failed}`,
          );
      } catch (error) {
        stats.failed++;
        failed = true;
        tally.failed++;
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
      // Release the lease and let the database schedule the next poll. A
      // failure here is logged (the lease simply expires); it never fails
      // the board or the pass.
      if (scheduled) {
        const { error } = await supabase.rpc("finish_board_poll", {
          p_board_id: board.id,
          p_owner: runKey,
          p_changed: written > 0 || closed > 0 || missed > 0,
          p_failed: failed,
        });
        if (error) {
          scheduleErrors++;
          if (scheduleErrors <= 3)
            console.warn("finish_board_poll failed", { boardId: board.id, code: error.code, message: error.message });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const completedAt = new Date();
  const claimed = queueStats();
  console.log("Collection complete", {
    ...stats,
    claimed: claimed.claimed,
    claims: claimed.claims,
    stoppedBy: claimed.stoppedBy,
    claimError: claimed.error,
    scheduleErrors,
    seconds: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
  });
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
  await recordPass({ runKey, startedAt, completedAt, sources, perSource, failures: measure.failures, stats });
  // Board-level failures are recorded per board (last_poll_status='error',
  // consecutive_failures, and now a backoff on next_due_at) and retried when
  // due; the run itself fails only when more than a small share of boards
  // failed, which signals a systemic problem (provider outage, database
  // timeouts, schema mismatch).
  const tolerated = Math.max(3, Math.floor((stats.completed + stats.failed) * 0.05));
  if (stats.failed > tolerated) {
    console.error(`Run failed: ${stats.failed} boards failed (tolerated ${tolerated})`);
    process.exitCode = 1;
  } else if (stats.failed) {
    console.warn(`${stats.failed} board(s) failed and will be retried next cycle`);
  }
}

/* ---------------- pass summary (observability) ---------------- */

/* Split of this pass's writes by event, read back from corpus_events over the
 * pass window for the pass's own sources (each event row carries the listing
 * whose source is the board's ATS; other shards' sources and the seed lists
 * are excluded by the filter). Bounded to 100 pages of 1,000 rows; a longer
 * window is reported as truncated. Best effort: any error leaves the split
 * unknown and the summary falls back to the collector's own counts. */
async function passEventCounts(sources: string[], from: Date, to: Date) {
  const counts: Record<string, { new: number; updated: number; reopened: number; closed: number }> = {};
  let rows = 0;
  for (let page = 0; page < 100; page++) {
    const { data, error } = await supabase
      .from("corpus_events")
      .select("event,corpus_listings!inner(source)")
      .gte("at", from.toISOString())
      .lte("at", to.toISOString())
      .in("corpus_listings.source", sources)
      .order("at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`corpus_events: ${error.message}`);
    const batch = (data ?? []) as unknown as { event: string; corpus_listings: { source: string } | null }[];
    for (const row of batch) {
      const source = row.corpus_listings?.source;
      if (!source) continue;
      const tally = (counts[source] ??= { new: 0, updated: 0, reopened: 0, closed: 0 });
      if (row.event === "new" || row.event === "updated" || row.event === "reopened" || row.event === "closed") tally[row.event]++;
    }
    rows += batch.length;
    if (batch.length < 1000) return { counts, rows, truncated: false };
  }
  return { counts, rows, truncated: true };
}

/* One row per pass through public.record_corpus_collection_pass (created by
 * the observability step of CP1). run_key = GitHub run id + attempt (+ shard)
 * or a UUID for local runs; failures = {code: count}; sources = {source:
 * {boards, failed, new, updated, reopened, closed, written}}. Never fails the
 * pass: a missing RPC or a failed insert is a warning. */
async function recordPass(input: {
  runKey: string;
  startedAt: Date;
  completedAt: Date;
  sources: string[];
  perSource: Record<string, SourceTally>;
  failures: Record<string, number>;
  stats: { completed: number; failed: number; postings: number };
}) {
  try {
    let events: Awaited<ReturnType<typeof passEventCounts>> | null = null;
    try {
      events = await passEventCounts(input.sources, input.startedAt, input.completedAt);
    } catch (error) {
      console.warn("pass summary: event split unavailable; 'new' carries every written row", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const sourcesJson: Record<string, Record<string, number>> = {};
    const totals = { boards: 0, failed: 0, new: 0, updated: 0, reopened: 0, closed: 0, written: 0 };
    for (const [source, tally] of Object.entries(input.perSource)) {
      const split = events?.counts[source];
      const row = {
        boards: tally.boards,
        failed: tally.failed,
        new: split ? split.new : tally.written,
        updated: split ? split.updated : 0,
        reopened: split ? split.reopened : 0,
        closed: tally.closed,
        written: tally.written,
      };
      sourcesJson[source] = row;
      totals.boards += row.boards;
      totals.failed += row.failed;
      totals.new += row.new;
      totals.updated += row.updated;
      totals.reopened += row.reopened;
      totals.closed += row.closed;
      totals.written += row.written;
    }
    console.log(
      "PASS_SUMMARY " +
        JSON.stringify({
          run_key: input.runKey,
          started_at: input.startedAt.toISOString(),
          completed_at: input.completedAt.toISOString(),
          ...totals,
          postings: input.stats.postings,
          basis: events ? "events" : "rpc-written",
          events_truncated: events?.truncated ?? null,
          failures: input.failures,
          sources: sourcesJson,
        }),
    );
    const { data, error } = await supabase.rpc("record_corpus_collection_pass", {
      p_run_key: input.runKey,
      p_started_at: input.startedAt.toISOString(),
      p_completed_at: input.completedAt.toISOString(),
      p_boards: totals.boards,
      p_failed: totals.failed,
      p_failures: input.failures,
      p_new: totals.new,
      p_updated: totals.updated,
      p_closed: totals.closed,
      p_reopened: totals.reopened,
      p_sources: sourcesJson,
    });
    if (error) {
      console.warn(
        isMissingRpc(error)
          ? "record_corpus_collection_pass is not available — pass summary not recorded"
          : `record_corpus_collection_pass failed: ${error.message}`,
      );
      return;
    }
    console.log(`pass recorded: ${String(data)}`);
  } catch (error) {
    console.warn("pass summary failed", { message: error instanceof Error ? error.message : String(error) });
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
  if (!isPrimaryAts(ats)) return "unknown";
  // Without credentials a USAJOBS probe cannot run; the registry state stays.
  if (ats === "usajobs" && !usajobsCredentials()) return "unknown";
  try {
    const eu =
      ats === "lever" &&
      Boolean(
        registryUrl && new URL(registryUrl).hostname === "jobs.eu.lever.co",
      );
    const result = await fetchPrimaryBoard(ats, slug, fetch, eu, usajobsCredentials());
    return result.jobs.length ? "active" : "empty";
  } catch {
    return "unknown";
  }
}

/* ---------------- country re-resolve (bounded backfill) ---------------- */

/* Phase 1 item 1.5 (Sep 17, 2026). Existing rows only get a country when the
 * collector rewrites them, so the third of open rows written before the label
 * resolver existed stays unrouted. This mode walks open, publicly listed rows
 * with no country by id in bounded pages, resolves their stored location
 * labels with the collector's resolver and writes country_codes +
 * country_evidence through apply_corpus_country_backfill
 * (docs/jobs-country-backfill-2026-09-17.sql): two columns, no description,
 * hash or snapshot rewrite; the discovery side table follows through its
 * trigger. Dry run unless COUNTRY_BACKFILL_WRITE=1. Bounds per run:
 * COUNTRY_BACKFILL_LIMIT rows written (default 5000), COUNTRY_BACKFILL_PAGE
 * rows read per page (default 2000, max 5000), 200-row RPC calls with pauses.
 * Resume with COUNTRY_BACKFILL_AFTER=<resume_after from the summary>. */
const BACKFILL_WRITE = process.env.COUNTRY_BACKFILL_WRITE === "1";
const BACKFILL_LIMIT = Math.max(1, Number(process.env.COUNTRY_BACKFILL_LIMIT ?? 5000) || 5000);
// PostgREST returns at most 1000 rows per request; a larger page made the
// "short page" stop condition fire after the first page (Sep 18 run).
const BACKFILL_PAGE = Math.min(1000, Math.max(100, Number(process.env.COUNTRY_BACKFILL_PAGE ?? 1000) || 1000));
const BACKFILL_CHUNK = 200;
const BACKFILL_CHUNK_PAUSE_MS = 250;
const BACKFILL_PAGE_PAUSE_MS = 1500;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function recountry() {
  let cursor: string | null = process.env.COUNTRY_BACKFILL_AFTER?.trim() || null;
  const stats = {
    write: BACKFILL_WRITE,
    pages: 0,
    read: 0,
    resolvable: 0,
    written: 0,
    skippedMalformed: 0,
    bySource: {} as Record<string, { read: number; resolvable: number }>,
    byCountry: {} as Record<string, number>,
    byMethod: {} as Record<string, number>,
    byUnresolved: {} as Record<string, number>,
  };
  const resolvedAt = new Date().toISOString();
  for (;;) {
    if (BACKFILL_WRITE ? stats.written >= BACKFILL_LIMIT : stats.read >= BACKFILL_LIMIT) break;
    let q = supabase
      .from("corpus_listings")
      .select("id,source,locations,country_evidence")
      .in("status", ["active", "reopened"])
      .eq("is_publicly_listed", true)
      .eq("country_codes", "{}")
      .order("id", { ascending: true })
      .limit(BACKFILL_PAGE);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw new Error(`recountry read after ${cursor ?? "start"}: ${error.message}`);
    const rows = (data ?? []) as { id: string; source: string; locations: unknown; country_evidence: Record<string, unknown> | null }[];
    if (!rows.length) break;
    stats.pages++;
    stats.read += rows.length;
    cursor = rows[rows.length - 1].id;
    const updates: Record<string, unknown>[] = [];
    for (const row of rows) {
      const source = (stats.bySource[row.source] ??= { read: 0, resolvable: 0 });
      source.read++;
      const resolution = resolveLocationCountries(Array.isArray(row.locations) ? row.locations : []);
      if (!resolution.countries.length) {
        const reason = resolution.unresolved_reason ?? "unknown";
        stats.byUnresolved[reason] = (stats.byUnresolved[reason] ?? 0) + 1;
        continue;
      }
      // Mirror the RPC's row validation so one odd label never fails a whole
      // run: 1..20 two-letter upper-case codes and an array of locations.
      const malformed =
        !Array.isArray(row.locations) ? "locations_not_array"
        : resolution.countries.length > 20 ? "too_many_countries"
        : resolution.countries.some((code) => !/^[A-Z]{2}$/.test(code)) ? "bad_country_code"
        : null;
      if (malformed) {
        stats.skippedMalformed++;
        console.warn(`recountry: skipped malformed row ${row.id} (${malformed}: ${resolution.countries.join(",")})`);
        continue;
      }
      source.resolvable++;
      stats.resolvable++;
      for (const code of resolution.countries) stats.byCountry[code] = (stats.byCountry[code] ?? 0) + 1;
      const method = resolution.method ?? "unknown";
      stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;
      updates.push({
        id: row.id,
        locations: row.locations,
        country_codes: resolution.countries,
        country_evidence: {
          ...(row.country_evidence && typeof row.country_evidence === "object" ? row.country_evidence : {}),
          ...locationCountryEvidenceFields(resolution),
          country_backfill: { at: resolvedAt, resolver: "location-country/2026-09-17" },
        },
      });
    }
    if (BACKFILL_WRITE) {
      for (let offset = 0; offset < updates.length && stats.written < BACKFILL_LIMIT; offset += BACKFILL_CHUNK) {
        const chunk = updates.slice(offset, Math.min(offset + BACKFILL_CHUNK, offset + (BACKFILL_LIMIT - stats.written)));
        const { data: applied, error: writeError } = await supabase.rpc("apply_corpus_country_backfill", { p_rows: chunk });
        if (writeError) throw new Error(`recountry write at ${chunk[0].id}: ${writeError.message}`);
        stats.written += Number((applied as { updated?: number } | null)?.updated ?? 0);
        await pause(BACKFILL_CHUNK_PAUSE_MS);
      }
    }
    console.log(`recountry: page ${stats.pages} read ${stats.read} resolvable ${stats.resolvable} written ${stats.written} after ${cursor}`);
    if (rows.length < BACKFILL_PAGE) break;
    await pause(BACKFILL_PAGE_PAUSE_MS);
  }
  console.log("RECOUNTRY_SUMMARY " + JSON.stringify({ ...stats, resume_after: cursor }));
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
        : mode === "recountry"
          ? recountry
          : null;
if (!run) {
  console.error("usage: node dist/run.cjs <seed|poll|verify|recountry>");
  process.exit(1);
}
run().catch((e) => {
  console.error(`${mode} FAILED:`, e);
  process.exit(1);
});
