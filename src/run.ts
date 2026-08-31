/**
 * Corveno corpus runner — seed refresh + ATS board poll + registry verify.
 * Usage: node dist/run.cjs <seed|poll|verify>
 *
 * All-roles mode: every posting is stored. Full descriptions are kept for
 * intern/new-grad rows; other roles keep a trimmed excerpt (classification
 * runs on the full text before trimming). "Still alive" bookkeeping is
 * write-throttled: last_seen only refreshes when >4h stale, and closure
 * requires absence with a stale last_seen — churn-proportional writes.
 *
 * Data sources gratefully consumed (see README attribution):
 * SimplifyJobs lists, vanshb03 lists, jobhive/ats-scrapers registry,
 * and the public Greenhouse / Lever / Ashby job board APIs.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const UA = { "User-Agent": "corveno-corpus (hello@corveno.io)" };
const CONCURRENCY = 40;
const SEEN_BUMP_STALE_MS = 4 * 60 * 60 * 1000;      // refresh last_seen if older
const CLOSE_STALE_MS = 13 * 60 * 60 * 1000;         // absent + this stale => miss/close

/* ---------------- classification ---------------- */

const INTERN_RE = /\bintern(ship)?s?\b|\bco[- ]?op\b|\bapprentice(ship)?\b/i;
const NEWGRAD_RE = /\bnew ?grad(uate)?\b|\buniversity grad(uate)?\b|\brecent grad(uate)?\b|\bcampus hire\b|\bgraduate (program|scheme|engineer|analyst)\b|\bclass of 20\d\d\b|\bearly career\b/i;
const TERM_RE = /\b(summer|fall|spring|winter)\s*'?(20)?(2[5-9])\b/gi;
const GRAD_RE = /\b(?:class of|graduating(?: in| by)?|expected graduation[:\s]*)\s*(20\d\d)\b/i;
const SPONSOR_NO_RE = /not (?:able to )?sponsor|unable to sponsor|without (?:the need for )?sponsorship|no sponsorship|sponsorship is not available/i;
const SPONSOR_CIT_RE = /u\.?s\.? citizen(ship)?(?: is)? required|citizens? only|security clearance|export control|itar/i;
const SPONSOR_YES_RE = /sponsorship (?:is )?available|will sponsor|able to sponsor/i;

function classify(title: string, structuredType: string | null, description: string | null) {
  let kind: "intern" | "new_grad" | "other" = "other";
  let source = "regex";
  if (structuredType && /intern/i.test(structuredType)) { kind = "intern"; source = "structured"; }
  else if (INTERN_RE.test(title)) kind = "intern";
  else if (NEWGRAD_RE.test(title)) kind = "new_grad";

  const terms: string[] = [];
  for (const m of title.matchAll(TERM_RE)) {
    const t = `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[3].length === 2 ? "20" + m[3] : m[3]}`;
    if (!terms.includes(t)) terms.push(t);
  }
  const gm = title.match(GRAD_RE) ?? description?.slice(0, 4000)?.match(GRAD_RE) ?? null;
  const grad_year = gm ? parseInt(gm[1], 10) : null;

  let sponsorship = "unknown";
  if (description) {
    const tail = description.length > 8000 ? description.slice(-6000) : description;
    if (SPONSOR_CIT_RE.test(tail)) sponsorship = "citizenship_required";
    else if (SPONSOR_NO_RE.test(tail)) sponsorship = "no";
    else if (SPONSOR_YES_RE.test(tail)) sponsorship = "offers";
  }
  return { kind, terms, grad_year, sponsorship, classify_source: source };
}

function stripHtml(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 20000);
}

/* ---------------- board fetchers ---------------- */

interface Fetched {
  uid: string; title: string; url: string; locations: string[];
  posted_at: string | null; updated_at: string | null;
  structuredType: string | null; description: string | null;
}

async function fetchBoard(ats: string, slug: string): Promise<Fetched[] | null> {
  try {
    if (ats === "greenhouse") {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, { headers: UA });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.jobs ?? []).map((j: Record<string, unknown>) => ({
        uid: String(j.id),
        title: String(j.title ?? ""),
        url: String(j.absolute_url ?? `https://job-boards.greenhouse.io/${slug}/jobs/${j.id}`),
        locations: j.location ? [String((j.location as { name?: string }).name ?? "")] : [],
        posted_at: (j.first_published as string) ?? null,
        updated_at: (j.updated_at as string) ?? null,
        structuredType: null,
        description: null,
      }));
    }
    if (ats === "lever") {
      const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, { headers: UA });
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data)) return null;
      return data.map((j: Record<string, unknown>) => {
        const cats = (j.categories ?? {}) as Record<string, unknown>;
        return {
          uid: String(j.id),
          title: String(j.text ?? ""),
          url: String(j.hostedUrl ?? `https://jobs.lever.co/${slug}/${j.id}`),
          locations: [cats.location, ...((cats.allLocations as string[]) ?? [])].filter(Boolean).map(String),
          posted_at: j.createdAt ? new Date(Number(j.createdAt)).toISOString() : null,
          updated_at: null,
          structuredType: (cats.commitment as string) ?? null,
          description: stripHtml((j.descriptionPlain as string) ?? (j.description as string)),
        };
      });
    }
    if (ats === "ashby") {
      const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`, { headers: UA });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.jobs ?? [])
        .filter((j: Record<string, unknown>) => j.isListed !== false)
        .map((j: Record<string, unknown>) => ({
          uid: String(j.id),
          title: String(j.title ?? ""),
          url: String(j.jobUrl ?? j.applyUrl ?? ""),
          locations: [j.location, ...(((j.secondaryLocations as { location?: string }[]) ?? []).map((s) => s.location))].filter(Boolean).map(String),
          posted_at: (j.publishedAt as string) ?? null,
          updated_at: null,
          structuredType: (j.employmentType as string) ?? null,
          description: stripHtml(j.descriptionPlain as string),
        }));
    }
  } catch { /* network */ }
  return null;
}

/* ---------------- shared helpers ---------------- */

async function pageAll<T>(table: string, select: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(select).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function upsertBatches(table: string, rows: Record<string, unknown>[], conflict: string, label: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict: conflict });
    if (error) throw new Error(`${label} @${i}: ${error.message}`);
    if (i % 5000 === 0) process.stdout.write(`\r${label}: ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }
  if (rows.length) console.log(`\r${label}: ${rows.length}/${rows.length}`);
}

/* ---------------- seed refresh ---------------- */

const SEEDS = [
  { url: "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json", source: "simplify-intern", kind: "intern" },
  { url: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json", source: "simplify-newgrad", kind: "new_grad" },
  { url: "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json", source: "vansh-intern", kind: "intern" },
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
    const res = await fetch(s.url, { headers: UA });
    if (!res.ok) { console.warn(`${s.source}: ${res.status} — skipped`); continue; }
    const listings = await res.json();
    const rows: Record<string, unknown>[] = [];
    for (const l of listings) {
      if (!l.id || !l.url || !l.company_name || !l.title) continue;
      const active = l.active !== false && l.is_visible !== false;
      rows.push({
        source: s.source,
        source_uid: l.id,
        company_name: String(l.company_name).slice(0, 200),
        title: String(l.title).slice(0, 300),
        canonical_url: String(l.url).slice(0, 800),
        locations: l.locations ?? [],
        kind: s.kind,
        terms: l.terms ?? (l.season ? [l.season] : []),
        sponsorship: SPONSOR_MAP[l.sponsorship ?? ""] ?? "unknown",
        status: active ? "active" : "closed",
        posted_at: epochToIso(l.date_posted),
        updated_at_source: epochToIso(l.date_updated),
        closed_at: active ? null : epochToIso(l.date_updated),
        classify_source: "seed",
      });
    }
    await upsertBatches("corpus_listings", rows, "source,source_uid", s.source);
  }
}

/* ---------------- board poll ---------------- */

async function poll() {
  const boards = await pageAll<{ id: string; name: string; ats: string; board_token: string; tier: string }>(
    "ats_companies", "id, name, ats, board_token, tier",
    (q) => q.eq("verify_status", "active")
  );
  boards.sort((a, b) => (a.tier === "intern-proven" ? -1 : 0) - (b.tier === "intern-proven" ? -1 : 0));
  console.log(`polling ${boards.length} boards…`);

  const existing = new Map<string, { id: string; status: string; missed: number; lastSeen: number }>();
  const rowsExisting = await pageAll<{ id: string; source: string; source_uid: string; status: string; missed_polls: number; last_seen_at: string }>(
    "corpus_listings", "id, source, source_uid, status, missed_polls, last_seen_at",
    (q) => q.in("source", ["greenhouse", "lever", "ashby"])
  );
  for (const r of rowsExisting) {
    existing.set(`${r.source}:${r.source_uid}`, { id: r.id, status: r.status, missed: r.missed_polls, lastSeen: new Date(r.last_seen_at).getTime() });
  }
  console.log(`existing polled listings: ${existing.size}`);

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const seen = new Set<string>();
  const newRows: Record<string, unknown>[] = [];
  const bumpIds: string[] = [];
  const reopenIds: string[] = [];
  const stats = { boards: 0, failed: 0, postings: 0 };
  const failedBoards = new Set<string>(); // never close listings under a failed board

  const queue = [...boards];
  const worker = async () => {
    for (;;) {
      const b = queue.shift();
      if (!b) return;
      const jobs = await fetchBoard(b.ats, b.board_token);
      stats.boards++;
      if (jobs === null) {
        stats.failed++;
        failedBoards.add(`${b.ats}:${b.board_token}`);
        await supabase.from("ats_companies").update({ last_polled_at: now, last_poll_status: "error" }).eq("id", b.id);
        continue;
      }
      stats.postings += jobs.length;
      for (const j of jobs) {
        if (!j.uid || !j.title || !j.url) continue;
        const cls = classify(j.title, j.structuredType, j.description);
        const key = `${b.ats}:${b.board_token}:${j.uid}`;
        seen.add(key);
        const ex = existing.get(key);
        if (!ex) {
          const keepFull = cls.kind !== "other";
          newRows.push({
            company_id: b.id,
            source: b.ats,
            source_uid: `${b.board_token}:${j.uid}`,
            company_name: b.name,
            title: j.title.slice(0, 300),
            canonical_url: j.url.slice(0, 800),
            locations: j.locations,
            description: keepFull ? j.description : j.description?.slice(0, 1500) ?? null,
            kind: cls.kind,
            terms: cls.terms,
            grad_year: cls.grad_year,
            sponsorship: cls.sponsorship,
            status: "active",
            posted_at: j.posted_at,
            updated_at_source: j.updated_at,
            classify_source: cls.classify_source,
          });
        } else if (ex.status === "closed") {
          reopenIds.push(ex.id);
        } else if (nowMs - ex.lastSeen > SEEN_BUMP_STALE_MS || ex.missed > 0) {
          bumpIds.push(ex.id); // write-throttled aliveness
        }
      }
      await supabase.from("ats_companies").update({ last_polled_at: now, last_poll_status: "ok" }).eq("id", b.id);
      if (stats.boards % 250 === 0) process.stdout.write(`\rboards:${stats.boards}/${boards.length} postings:${stats.postings} new:${newRows.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\nfetched — postings:${stats.postings} boardErrors:${stats.failed} new:${newRows.length}`);

  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < newRows.length; i += 500) {
    const chunk = newRows.slice(i, i + 500);
    const { data, error } = await supabase.from("corpus_listings").upsert(chunk, { onConflict: "source,source_uid" }).select("id");
    if (error) throw new Error(`insert @${i}: ${error.message}`);
    for (const r of data ?? []) events.push({ listing_id: r.id, event: "new", meta: {} });
    if (i % 5000 === 0) process.stdout.write(`\rinsert: ${Math.min(i + 500, newRows.length)}/${newRows.length}`);
  }
  if (newRows.length) console.log();

  for (let i = 0; i < bumpIds.length; i += 500) {
    await supabase.from("corpus_listings").update({ last_seen_at: now, missed_polls: 0 }).in("id", bumpIds.slice(i, i + 500));
  }
  for (let i = 0; i < reopenIds.length; i += 500) {
    const chunk = reopenIds.slice(i, i + 500);
    await supabase.from("corpus_listings").update({ status: "reopened", last_seen_at: now, missed_polls: 0, closed_at: null }).in("id", chunk);
    for (const id of chunk) events.push({ listing_id: id, event: "reopened", meta: {} });
  }

  // closure: absent from this cycle AND stale beyond the bump window
  const firstMiss: string[] = [];
  const closing: string[] = [];
  for (const [key, ex] of existing) {
    if (seen.has(key) || ex.status === "closed") continue;
    const board = key.split(":").slice(0, 2).join(":");
    if (failedBoards.has(board)) continue;
    if (nowMs - ex.lastSeen < CLOSE_STALE_MS) continue; // still within safety window
    if (ex.missed + 1 >= 2) closing.push(ex.id);
    else firstMiss.push(ex.id);
  }
  for (let i = 0; i < firstMiss.length; i += 500) {
    await supabase.from("corpus_listings").update({ missed_polls: 1 }).in("id", firstMiss.slice(i, i + 500));
  }
  for (let i = 0; i < closing.length; i += 500) {
    const chunk = closing.slice(i, i + 500);
    await supabase.from("corpus_listings").update({ status: "closed", closed_at: now, missed_polls: 2 }).in("id", chunk);
    for (const id of chunk) events.push({ listing_id: id, event: "closed", meta: {} });
  }
  for (let i = 0; i < events.length; i += 500) {
    await supabase.from("corpus_events").insert(events.slice(i, i + 500));
  }
  console.log(`DONE — new:${newRows.length} bumped:${bumpIds.length} reopened:${reopenIds.length} firstMiss:${firstMiss.length} closed:${closing.length}`);
}

/* ---------------- registry verify (weekly) ---------------- */

async function verify() {
  const companies = await pageAll<{ id: string; ats: string; board_token: string }>(
    "ats_companies", "id, ats, board_token, tier"
  );
  console.log(`verifying ${companies.length} boards…`);
  const counts = { active: 0, empty: 0, dead: 0 };
  let done = 0;
  const queue = [...companies];
  const worker = async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const status = await probe(c.ats, c.board_token);
      counts[status]++;
      await supabase.from("ats_companies").update({ verify_status: status, last_verified_at: new Date().toISOString() }).eq("id", c.id);
      if (++done % 500 === 0) process.stdout.write(`\r${done}/${companies.length}`);
    }
  };
  await Promise.all(Array.from({ length: 30 }, worker));
  console.log(`\nDONE — active:${counts.active} empty:${counts.empty} dead:${counts.dead}`);
}

async function probe(ats: string, slug: string): Promise<"active" | "empty" | "dead"> {
  const urls: Record<string, string> = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    lever: `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
  };
  const url = urls[ats];
  if (!url) return "dead";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: UA });
    if (!res.ok) return "dead";
    const reader = res.body?.getReader();
    let head = "";
    if (reader) {
      while (head.length < 400) {
        const { done, value } = await reader.read();
        if (done) break;
        head += new TextDecoder().decode(value);
      }
      ctrl.abort();
    }
    const c = head.replace(/\s+/g, "");
    if (ats === "lever") return c.startsWith("[{") ? "active" : c.startsWith("[]") ? "empty" : "dead";
    if (c.includes('"jobs":[{')) return "active";
    if (c.includes('"jobs":[]')) return "empty";
    return c.startsWith('{"jobs":[') ? "active" : "dead";
  } catch {
    return "dead";
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- entry ---------------- */

const mode = process.argv[2];
const run = mode === "seed" ? seed : mode === "verify" ? verify : mode === "poll" ? poll : null;
if (!run) {
  console.error("usage: node dist/run.cjs <seed|poll|verify>");
  process.exit(1);
}
run().catch((e) => {
  console.error(`${mode} FAILED:`, e);
  process.exit(1);
});
