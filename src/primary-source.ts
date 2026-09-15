import { createHash } from "node:crypto";
import { explicitCountryAlias } from "./country-evidence";
export type PrimaryAts = "greenhouse" | "lever" | "ashby";
export interface SourceJob {
  uid: string;
  title: string;
  url: string;
  locations: string[];
  posted_at: string | null;
  updated_at: string | null;
  structuredType: string | null;
  structured_job_type: string | null;
  description: string | null;
  description_complete: boolean;
  country_codes: string[];
  country_evidence: Record<string, unknown>;
  is_publicly_listed: boolean;
  source_record_json: string;
  source_content_sha256: string;
  issues: string[];
}
export class CollectionError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
const iso3: Record<string, string> = {
  USA: "US",
  CAN: "CA",
  AUS: "AU",
  GBR: "GB",
  IND: "IN",
  SGP: "SG",
  JPN: "JP",
  DEU: "DE",
  FRA: "FR",
  IRL: "IE",
  NLD: "NL",
  NZL: "NZ",
  CHE: "CH",
  SWE: "SE",
  ESP: "ES",
  ITA: "IT",
  POL: "PL",
  CHN: "CN",
  KOR: "KR",
  HKG: "HK",
  TWN: "TW",
  BRA: "BR",
  MEX: "MX",
  ARE: "AE",
  ISR: "IL",
  ZAF: "ZA",
  IDN: "ID",
  MYS: "MY",
  PHL: "PH",
  VNM: "VN",
  THA: "TH",
  PRT: "PT",
  AUT: "AT",
  BEL: "BE",
  DNK: "DK",
  FIN: "FI",
  NOR: "NO",
  CZE: "CZ",
  LUX: "LU",
  ROU: "RO",
  HUN: "HU",
  GRC: "GR",
  TUR: "TR",
  ARG: "AR",
  CHL: "CL",
  COL: "CO",
  PER: "PE",
  PAK: "PK",
  BGD: "BD",
  LKA: "LK",
  NPL: "NP",
  EGY: "EG",
  KEN: "KE",
  NGA: "NG",
  SAU: "SA",
  QAT: "QA",
  KWT: "KW",
  BHR: "BH",
};
const regions = new Intl.DisplayNames(["en"], {
  type: "region",
  fallback: "none",
});
// CLDR includes deprecated/reserved regions as well as countries. Do not
// silently normalize a full country name to an obsolete region identifier.
const excludedRegions = new Set(
  "AC AN BU CP CS DD DG EA EU EZ FX IC NT QO SU TA TP UN XA XB YD YU ZR ZZ".split(
    " ",
  ),
);
const countryNames = new Map<string, string>([
  ["united states of america", "US"],
]);
for (let a = 65; a <= 90; a++)
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b),
      name = regions.of(code);
    if (
      name &&
      !excludedRegions.has(code) &&
      !countryNames.has(name.toLowerCase())
    )
      countryNames.set(name.toLowerCase(), code);
  }
export function explicitCountry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim(),
    upper = value.toUpperCase();
  if (upper === "UK") return "GB";
  if (iso3[upper]) return iso3[upper];
  if (
    /^[A-Z]{2}$/.test(upper) &&
    !excludedRegions.has(upper) &&
    regions.of(upper)
  )
    return upper;
  return countryNames.get(value.toLowerCase()) ?? explicitCountryAlias(value);
}
function decodeEntities(raw: string): string {
  return raw.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (all, name: string) => {
      const n = name.toLowerCase();
      if (n[0] === "#") {
        const point =
          n[1] === "x" ? parseInt(n.slice(2), 16) : Number(n.slice(1));
        return point > 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : all;
      }
      return (
        (
          {
            amp: "&",
            lt: "<",
            gt: ">",
            quot: '"',
            apos: "'",
            nbsp: " ",
          } as Record<string, string>
        )[n] ?? all
      );
    },
  );
}
export function plainText(raw: string): string {
  // Some Greenhouse responses escape the whole HTML document. Unwrap only
  // that document layer, then strip markup before decoding text entities.
  // Decoding every entity first would erase literal types such as &lt;T&gt;.
  let html = raw;
  const structure =
    "(?:html|body|p|div|span|ul|ol|li|h[1-6]|br|section|article|table|strong|em)";
  const literalMarkup = new RegExp(`<\\/?${structure}\\b`, "i");
  const escapedMarkup = new RegExp(
    `&(?:amp;)?lt;\\/?${structure}(?:&|\\s|>)`,
    "i",
  );
  for (
    let depth = 0;
    depth < 2 && !literalMarkup.test(html) && escapedMarkup.test(html);
    depth++
  )
    html = decodeEntities(html);
  const stripped = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*(?:br\b[^>]*|\/(?:p|div|li|h[1-6]))\s*\/?>/gi, "\n")
    .replace(
      /<\/?(?:html|body|head|title|meta|link|a|abbr|address|article|aside|b|blockquote|button|caption|code|col|dd|del|details|div|dl|dt|em|fieldset|figcaption|figure|font|footer|form|h[1-6]|header|hr|i|iframe|img|input|label|legend|li|main|nav|ol|option|p|pre|s|section|select|small|span|strong|sub|summary|sup|table|tbody|td|textarea|th|thead|time|tr|u|ul)\b[^>]*>/gi,
      " ",
    );
  return decodeEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
function stable(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, stable(v)]),
        )
      : value;
}
function text(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function date(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const time =
    typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
export function employmentType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return (
    (
      {
        fulltime: "full_time",
        parttime: "part_time",
        intern: "internship",
        internship: "internship",
        contract: "contract",
        contractor: "contract",
        temporary: "temporary",
        coop: "co_op",
        apprenticeship: "apprenticeship",
        research: "research",
      } as Record<string, string>
    )[value.toLowerCase().replace(/[\s_-]/g, "")] ?? null
  );
}
/** Positive complete location labels only. Plain remote, exclusions and
 * travel/global-team language do not establish worldwide hiring. */
function worldwideEvidence(fields: { path: string; raw: unknown }[], job: Record<string, any>) {
  const workplace = typeof job.workplaceType === "string" ? job.workplaceType.trim().toLowerCase() : null;
  if (job.isRemote === false || workplace === "onsite" || workplace === "on-site" || workplace === "hybrid") return null;
  const remote = workplace === "remote" ? { path: "workplaceType", value: job.workplaceType } : job.isRemote === true ? { path: "isRemote", value: true } : null;
  const scope = "(?:worldwide|anywhere in the world)";
  const combined = new RegExp(`^(?:remote\\s*(?:[-–—|:,/]\\s*)?${scope}|remote\\s*\\(\\s*${scope}\\s*\\)|${scope}\\s*(?:[-–—|:,/]\\s*)?remote)$`, "i");
  for (const field of fields) {
    if (typeof field.raw !== "string") continue;
    const label = field.raw.trim().replace(/\s+/g, " ");
    if (combined.test(label) || remote && new RegExp(`^${scope}$`, "i").test(label))
      return { fieldPath: field.path, quote: field.raw, ...(remote ? { remoteEvidence: remote } : {}) };
  }
  return null;
}
function normalizeJob(ats: PrimaryAts, slug: string, raw: unknown): SourceJob {
  const j = object(raw),
    cats = object(j.categories),
    issues: string[] = [];
  const uid =
    typeof j.id === "string"
      ? j.id
      : typeof j.id === "number" && Number.isSafeInteger(j.id)
        ? String(j.id)
        : null;
  const title = text(ats === "lever" ? j.text : j.title),
    url = text(
      ats === "greenhouse"
        ? j.absolute_url
        : ats === "lever"
          ? j.hostedUrl
          : (j.jobUrl ?? j.applyUrl),
    );
  if (
    !uid ||
    !title?.trim() ||
    !url ||
    uid.length > 200 ||
    title.length > 2000 ||
    url.length > 8192
  )
    throw new CollectionError("MALFORMED_JOB");
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw Error();
  } catch {
    throw new CollectionError("MALFORMED_JOB_URL");
  }
  const rawJson = JSON.stringify(stable(j));
  if (Buffer.byteLength(rawJson, "utf8") > 1048576)
    throw new CollectionError("JOB_TOO_LARGE");
  let description: string | null = null;
  if (ats === "greenhouse")
    description = text(j.content) !== null ? plainText(j.content) : null;
  if (ats === "ashby")
    description = text(j.descriptionHtml)
      ? plainText(j.descriptionHtml)
      : text(j.descriptionPlain);
  if (ats === "lever") {
    if (
      j.lists !== undefined &&
      (!Array.isArray(j.lists) ||
        j.lists.some(
          (item: unknown) => typeof object(item).content !== "string",
        ))
    )
      throw new CollectionError("MALFORMED_DESCRIPTION_LISTS");
    const body =
      text(j.descriptionPlain) ??
      (text(j.description) ? plainText(j.description) : null);
    const lists = (j.lists ?? []).map((item: any) =>
      [text(item.text), plainText(item.content)].filter(Boolean).join("\n"),
    );
    const additional =
      text(j.additionalPlain) ??
      (text(j.additional) ? plainText(j.additional) : null);
    description =
      [body, ...lists, additional].filter(Boolean).join("\n\n") || null;
  }
  const originalDescription = description;
  if (description?.includes("\0")) {
    description = description.replaceAll("\0", "");
    issues.push("description:nul-removed-in-readable-copy-original-retained");
  }
  const locationFields: { path: string; raw: unknown }[] =
    ats === "greenhouse" ? [{ path: "location.name", raw: object(j.location).name }]
      : ats === "lever" ? [{ path: "categories.location", raw: cats.location },
        ...(Array.isArray(cats.allLocations) ? cats.allLocations.map((raw: unknown, i: number) => ({ path: `categories.allLocations[${i}]`, raw })) : [])]
        : [{ path: "location", raw: j.location },
          ...(Array.isArray(j.secondaryLocations) ? j.secondaryLocations.map((location: unknown, i: number) => ({ path: `secondaryLocations[${i}].location`, raw: object(location).location })) : [])];
  const locations = locationFields.map(field => field.raw);
  const countryFields: { path: string; raw: unknown }[] =
    ats === "lever"
      ? [{ path: "country", raw: j.country }]
      : ats === "ashby"
        ? [
            {
              path: "address.postalAddress.addressCountry",
              raw: object(object(j.address).postalAddress).addressCountry,
            },
            ...(Array.isArray(j.secondaryLocations)
              ? j.secondaryLocations.map((l: unknown, i: number) => ({
                  path: `secondaryLocations[${i}].address.addressCountry`,
                  raw: object(object(l).address).addressCountry,
                }))
              : []),
          ]
        : [];
  const evidence = countryFields.filter(
      (f) => f.raw !== null && f.raw !== undefined,
    ),
    countries = [
      ...new Set(
        evidence
          .map((f) => explicitCountry(f.raw))
          .filter((v): v is string => v !== null),
      ),
    ];
  for (const f of evidence)
    if (!explicitCountry(f.raw)) issues.push(`country:unrecognized:${f.path}`);
  const worldwide = worldwideEvidence([...locationFields, ...countryFields], j);
  const structuredType = text(
    ats === "lever"
      ? cats.commitment
      : ats === "ashby"
        ? j.employmentType
        : null,
  );
  const listed = ats !== "ashby" || j.isListed !== false;
  if (
    ats === "ashby" &&
    j.isListed !== undefined &&
    typeof j.isListed !== "boolean"
  )
    throw new CollectionError("MALFORMED_VISIBILITY");
  return {
    uid,
    title,
    url,
    locations: [
      ...new Set(
        locations.filter(
          (l): l is string => typeof l === "string" && Boolean(l.trim()),
        ),
      ),
    ],
    posted_at: date(
      ats === "lever"
        ? j.createdAt
        : ats === "ashby"
          ? j.publishedAt
          : j.first_published,
    ),
    updated_at: date(j.updated_at),
    structuredType,
    structured_job_type: employmentType(structuredType),
    description,
    description_complete:
      Boolean(originalDescription?.trim()) &&
      description === originalDescription,
    country_codes: countries,
    country_evidence: {
      source: `${ats}-api`,
      fieldPaths: evidence.map((f) => f.path),
      rawValues: evidence.map((f) => f.raw),
      ...(worldwide ? { remote_scope: "worldwide", worldwide_evidence: worldwide } : {}),
    },
    is_publicly_listed: listed,
    source_record_json: rawJson,
    source_content_sha256: createHash("sha256").update(rawJson).digest("hex"),
    issues,
  };
}
export function parseBoardResponse(
  ats: PrimaryAts,
  slug: string,
  data: unknown,
): SourceJob[] & { skippedMalformed?: number } {
  const wrapper = object(data),
    rows = ats === "lever" ? data : wrapper.jobs;
  if (!Array.isArray(rows)) throw new CollectionError("MALFORMED_BOARD");
  if (
    ats === "greenhouse" &&
    (!Number.isSafeInteger(object(wrapper.meta).total) ||
      object(wrapper.meta).total !== rows.length)
  )
    throw new CollectionError("INCOMPLETE_BOARD");
  for (const key of [
    "next",
    "nextPage",
    "nextCursor",
    "hasMore",
    "hasNextPage",
  ]) {
    if (wrapper[key]) throw new CollectionError("UNEXPECTED_PAGINATION");
  }
  if (rows.length > 50000) throw new CollectionError("TOO_MANY_JOBS");
  // A record without a usable identity, title or URL is skipped (counted in
  // `skippedMalformed`) rather than failing the whole board: it cannot be
  // stored or applied to, and a previously stored version of it is treated as
  // absent by the normal two-snapshot closure. Oversized records and
  // structural board problems still fail the snapshot.
  const jobs: SourceJob[] = [];
  let skippedMalformed = 0;
  for (const row of rows) {
    try {
      jobs.push(normalizeJob(ats, slug, row));
    } catch (error) {
      if (error instanceof CollectionError && (error.code === "MALFORMED_JOB" || error.code === "MALFORMED_JOB_URL")) skippedMalformed++;
      else throw error;
    }
  }
  // A board with no valid record, or with more than a handful of malformed
  // ones (>5 and >10% of rows), is a structural problem: fail the snapshot
  // rather than let an empty/partial capture close its listings.
  if (skippedMalformed > 0 && (jobs.length === 0 || skippedMalformed > Math.max(5, Math.floor(rows.length * 0.1))))
    throw new CollectionError("MALFORMED_JOB");
  if (new Set(jobs.map((j) => j.uid)).size !== jobs.length)
    throw new CollectionError("DUPLICATE_JOB_ID");
  return Object.assign(jobs, { skippedMalformed });
}
export function boardUrl(ats: PrimaryAts, slug: string, eu = false): string {
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(slug))
    throw new CollectionError("INVALID_BOARD");
  const board = encodeURIComponent(slug);
  return ats === "greenhouse"
    ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`
    : ats === "lever"
      ? `https://api.${eu ? "eu." : ""}lever.co/v0/postings/${board}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${board}`;
}
async function abortable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new CollectionError("BODY_TIMEOUT");
  let abort: () => void = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    abort = () => reject(new CollectionError("BODY_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancellation]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export async function boundedJson(
  url: string,
  fetcher: typeof fetch = fetch,
  maxBytes = 25165824,
  timeoutMs = 30000,
  allowPlainJson = false,
): Promise<unknown> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await abortable(
      fetcher(url, {
        signal: controller.signal,
        redirect: "error",
        headers: {
          "User-Agent": "Corveno corpus (hello@corveno.io)",
          Accept: "application/json",
        },
      }),
      controller.signal,
    );
    if (!response.ok) throw new CollectionError(`HTTP_${response.status}`);
    if (response.status === 206 || response.headers.has("content-range"))
      throw new CollectionError("PARTIAL_RESPONSE");
    if (
      !/\bjson\b/i.test(response.headers.get("content-type") ?? "") &&
      !(
        allowPlainJson &&
        /^text\/plain\b/i.test(response.headers.get("content-type") ?? "")
      )
    )
      throw new CollectionError("NOT_JSON");
    if (Number(response.headers.get("content-length")) > maxBytes)
      throw new CollectionError("BODY_TOO_LARGE");
    const reader = response.body?.getReader();
    if (!reader) throw new CollectionError("EMPTY_RESPONSE");
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      for (;;) {
        const part = await abortable(reader.read(), controller.signal);
        if (part.done) break;
        count += part.value.byteLength;
        if (count > maxBytes) throw new CollectionError("BODY_TOO_LARGE");
        chunks.push(part.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new CollectionError("INVALID_JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}
export async function fetchPrimaryBoard(
  ats: PrimaryAts,
  slug: string,
  fetcher: typeof fetch = fetch,
  eu = false,
): Promise<{ jobs: SourceJob[]; checkedAt: string; sourceUrl: string; skippedMalformed: number }> {
  const url = boardUrl(ats, slug, eu),
    started = Date.now();
  if (ats !== "lever") {
    const parsed = parseBoardResponse(ats, slug, await boundedJson(url, fetcher));
    return {
      jobs: parsed,
      skippedMalformed: parsed.skippedMalformed ?? 0,
      checkedAt: new Date().toISOString(),
      sourceUrl: url,
    };
  }
  let skippedMalformed = 0;
  const jobs: SourceJob[] = [],
    ids = new Set<string>();
  let bytes = 0;
  for (let skip = 0; skip <= 50000; ) {
    if (Date.now() - started > 60000)
      throw new CollectionError("BOARD_TIMEOUT");
    const page = await boundedJson(
      `${url}&limit=100&skip=${skip}`,
      fetcher,
      8388608,
      Math.min(30000, 60000 - (Date.now() - started)),
    );
    const normalized = parseBoardResponse(ats, slug, page);
    skippedMalformed += normalized.skippedMalformed ?? 0;
    if (normalized.length > 100)
      throw new CollectionError("PAGINATION_IGNORED");
    for (const job of normalized) {
      if (ids.has(job.uid)) throw new CollectionError("UNSTABLE_PAGINATION");
      ids.add(job.uid);
      jobs.push(job);
      bytes += Buffer.byteLength(job.source_record_json);
      if (bytes > 25165824) throw new CollectionError("BOARD_TOO_LARGE");
    }
    if (normalized.length === 0)
      return { jobs, checkedAt: new Date().toISOString(), sourceUrl: url, skippedMalformed };
    skip += normalized.length;
  }
  throw new CollectionError("TOO_MANY_JOBS");
}
