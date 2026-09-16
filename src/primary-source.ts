import { createHash } from "node:crypto";
import { explicitCountryAlias } from "./country-evidence";
/** Every primary source the collector can read. The first three are the
 * original ATS APIs; the rest were authorised on 2026-09-16
 * (docs/jobs-source-authorization-2026-09-16.md) for matching only. */
export type PrimaryAts =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "recruitee"
  | "workable"
  | "breezy"
  | "pinpoint"
  | "teamtailor"
  | "usajobs";
export const PRIMARY_ATS: readonly PrimaryAts[] = [
  "greenhouse",
  "lever",
  "ashby",
  "recruitee",
  "workable",
  "breezy",
  "pinpoint",
  "teamtailor",
  "usajobs",
];
export const isPrimaryAts = (value: unknown): value is PrimaryAts =>
  typeof value === "string" && (PRIMARY_ATS as readonly string[]).includes(value);
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
/** USAJOBS Search API credentials. Registered by the account holder; never
 * embedded in code. Missing credentials make USAJOBS boards skip, not fail. */
export interface UsajobsCredentials {
  apiKey: string;
  userAgent: string;
}
export function usajobsCredentials(
  env: Record<string, string | undefined> | undefined = typeof process ===
  "undefined"
    ? undefined
    : process.env,
): UsajobsCredentials | null {
  const apiKey = env?.USAJOBS_API_KEY?.trim(),
    userAgent = env?.USAJOBS_USER_AGENT?.trim();
  return apiKey && userAgent ? { apiKey, userAgent } : null;
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
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
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
    .replace(/<!--[\s\S]*?-->/g, "")
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
/** A non-blank source label; blank strings are treated as absent. */
function label(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function html(v: unknown): string | null {
  return label(v) ? plainText(v as string) : null;
}
function date(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const time =
    typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
/** Timestamps without a zone designator (USAJOBS: "2026-09-01T00:00:00.0000")
 * are read as UTC so the stored instant does not depend on the collector's
 * machine zone. */
function unzonedDate(v: unknown): string | null {
  return date(
    typeof v === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(v.trim())
      ? `${v.trim()}Z`
      : v,
  );
}
function identity(v: unknown): string | null {
  return typeof v === "string"
    ? v
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : null;
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
        internships: "internship",
        contract: "contract",
        contractor: "contract",
        temporary: "temporary",
        coop: "co_op",
        apprenticeship: "apprenticeship",
        research: "research",
        // Compound provider codes (Recruitee `employment_type_code`) and
        // labels used by the feeds authorised 2026-09-16. Fixed-term work is
        // a contract, seasonal/temp work is temporary, freelance is contract —
        // the same reading as employmentTypeFromLabel in employment-evidence.
        fulltimepermanent: "full_time",
        parttimepermanent: "part_time",
        fulltimefixedterm: "full_time",
        parttimefixedterm: "part_time",
        fulltimetemporary: "temporary",
        parttimetemporary: "temporary",
        fixedterm: "full_time",
        freelance: "contract",
        temp: "temporary",
        seasonal: "temporary",
      } as Record<string, string>
    )[value.toLowerCase().replace(/[\s_-]/g, "")] ?? null
  );
}
interface Field {
  path: string;
  raw: unknown;
}
/** Remote flags a source states explicitly; used only to qualify a
 * worldwide-remote location label, never to establish one. */
interface RemoteFlags {
  workplaceType?: unknown;
  isRemote?: unknown;
}
/** Positive complete location labels only. Plain remote, exclusions and
 * travel/global-team language do not establish worldwide hiring. */
function worldwideEvidence(fields: Field[], job: RemoteFlags) {
  const workplace = typeof job.workplaceType === "string" ? job.workplaceType.trim().toLowerCase() : null;
  if (job.isRemote === false || workplace === "onsite" || workplace === "on-site" || workplace === "on_site" || workplace === "hybrid") return null;
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
/** What one provider record states, before the shared validation, hashing
 * and evidence steps. Every source maps into this shape; nothing here guesses. */
interface Extracted {
  uid: string | null;
  title: string | null;
  url: string | null;
  description: string | null;
  locationFields: Field[];
  countryFields: Field[];
  structuredType: string | null;
  posted_at: string | null;
  updated_at: string | null;
  listed: boolean;
  remote: RemoteFlags;
}
/** Sections of a posting joined the way the Lever body/lists/additional
 * sections are: each section is plain text, optionally under its own label. */
function sections(parts: (string | null | { heading: string | null; body: string | null })[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    if (part === null) continue;
    if (typeof part === "string") {
      if (part.trim()) out.push(part);
      continue;
    }
    if (!part.body?.trim()) continue;
    out.push(part.heading?.trim() ? `${part.heading.trim()}\n${part.body}` : part.body);
  }
  return out.join("\n\n") || null;
}
function joined(...parts: unknown[]): string | null {
  const labels = parts.map(label).filter((v): v is string => v !== null);
  return [...new Set(labels.map((v) => v.trim()))].join(", ") || null;
}
function extract(ats: PrimaryAts, j: Record<string, any>): Extracted {
  const cats = object(j.categories);
  const base: Extracted = {
    uid: identity(j.id),
    title: text(j.title),
    url: null,
    description: null,
    locationFields: [],
    countryFields: [],
    structuredType: null,
    posted_at: null,
    updated_at: date(j.updated_at),
    listed: true,
    remote: { workplaceType: j.workplaceType, isRemote: j.isRemote },
  };
  switch (ats) {
    case "greenhouse":
      return {
        ...base,
        url: text(j.absolute_url),
        description: text(j.content) !== null ? plainText(j.content) : null,
        locationFields: [{ path: "location.name", raw: object(j.location).name }],
        posted_at: date(j.first_published),
      };
    case "lever": {
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
      return {
        ...base,
        title: text(j.text),
        url: text(j.hostedUrl),
        description:
          [body, ...lists, additional].filter(Boolean).join("\n\n") || null,
        locationFields: [
          { path: "categories.location", raw: cats.location },
          ...array(cats.allLocations).map((raw, i) => ({ path: `categories.allLocations[${i}]`, raw })),
        ],
        countryFields: [{ path: "country", raw: j.country }],
        structuredType: text(cats.commitment),
        posted_at: date(j.createdAt),
      };
    }
    case "ashby":
      if (j.isListed !== undefined && typeof j.isListed !== "boolean")
        throw new CollectionError("MALFORMED_VISIBILITY");
      return {
        ...base,
        url: text(j.jobUrl ?? j.applyUrl),
        description: text(j.descriptionHtml)
          ? plainText(j.descriptionHtml)
          : text(j.descriptionPlain),
        locationFields: [
          { path: "location", raw: j.location },
          ...array(j.secondaryLocations).map((location, i) => ({ path: `secondaryLocations[${i}].location`, raw: object(location).location })),
        ],
        countryFields: [
          {
            path: "address.postalAddress.addressCountry",
            raw: object(object(j.address).postalAddress).addressCountry,
          },
          ...array(j.secondaryLocations).map((l, i) => ({
            path: `secondaryLocations[${i}].address.addressCountry`,
            raw: object(object(l).address).addressCountry,
          })),
        ],
        structuredType: text(j.employmentType),
        posted_at: date(j.publishedAt),
        listed: j.isListed !== false,
      };
    case "recruitee": {
      // Careers-site offers API: description + requirements HTML, one
      // country_code per location, employment_type_code, published_at,
      // careers_url (posting page) / careers_apply_url.
      const locations = array(j.locations).map(object);
      return {
        ...base,
        url: text(j.careers_url) ?? text(j.careers_apply_url),
        description: sections([html(j.description), html(j.requirements)]),
        locationFields: [
          { path: "location", raw: j.location },
          ...locations.map((l, i) => ({ path: `locations[${i}]`, raw: joined(l.city ?? l.name, l.country) })),
        ],
        countryFields: [
          { path: "country_code", raw: j.country_code },
          ...locations.map((l, i) => ({ path: `locations[${i}].country_code`, raw: l.country_code })),
        ],
        structuredType: label(j.employment_type_code),
        posted_at: date(j.published_at),
        remote: { isRemote: typeof j.remote === "boolean" ? j.remote : undefined },
      };
    }
    case "workable": {
      // Public widget API (?details=true adds `description`). Locations carry
      // countryCode; the top-level country is a name. published_on is a date.
      const locations = array(j.locations).map(object).filter((l) => l.hidden !== true);
      return {
        ...base,
        uid: identity(j.shortcode),
        url: text(j.url) ?? text(j.shortlink) ?? text(j.application_url),
        description: html(j.description),
        locationFields: locations.length
          ? locations.map((l, i) => ({ path: `locations[${i}]`, raw: joined(l.city, l.region, l.country) }))
          : [{ path: "location", raw: joined(j.city, j.state, j.country) }],
        countryFields: [
          { path: "country", raw: label(j.country) },
          ...locations.map((l, i) => ({ path: `locations[${i}].countryCode`, raw: l.countryCode })),
        ],
        structuredType: label(j.employment_type),
        posted_at: date(label(j.published_on)),
        updated_at: null,
        remote: { isRemote: typeof j.telecommuting === "boolean" ? j.telecommuting : undefined },
      };
    }
    case "breezy": {
      // Positions list JSON (`name`, `url`, `published_date`, `type{name}`,
      // `location{country{id,name},is_remote}`); the description comes from
      // the bounded position-page fetch and is stored on the record as
      // `position_page_description` (HTML) so the content hash covers it.
      const primary = object(j.location);
      const locations = array(j.locations).map(object);
      const countryOf = (l: Record<string, any>) => object(l.country).id ?? object(l.country).name ?? l.country;
      return {
        ...base,
        title: text(j.name),
        url: text(j.url),
        description: html(j.position_page_description),
        locationFields: [
          { path: "location.name", raw: primary.name },
          ...locations.map((l, i) => ({ path: `locations[${i}].name`, raw: l.name })),
        ],
        countryFields: [
          { path: "location.country", raw: countryOf(primary) },
          ...locations.map((l, i) => ({ path: `locations[${i}].country`, raw: countryOf(l) })),
        ],
        structuredType: label(object(j.type).name) ?? label(object(j.type).id),
        posted_at: date(j.published_date),
        updated_at: null,
        remote: { isRemote: typeof primary.is_remote === "boolean" ? primary.is_remote : undefined },
      };
    }
    case "pinpoint": {
      // postings.json: four HTML sections with their headers, employment_type,
      // workplace_type, `location{name,city,province}`. No publication date is
      // documented, so posted_at stays null (first-seen stays first-seen). The
      // location name is a country only when the source wrote a country there.
      const loc = object(j.location);
      const countryName = label(loc.name) && explicitCountry(loc.name) ? loc.name : null;
      return {
        ...base,
        url: text(j.url),
        description: sections([
          html(j.description),
          { heading: label(j.key_responsibilities_header), body: html(j.key_responsibilities) },
          { heading: label(j.skills_knowledge_expertise_header), body: html(j.skills_knowledge_expertise) },
          { heading: label(j.benefits_header), body: html(j.benefits) },
        ]),
        locationFields: [
          { path: "location.name", raw: loc.name },
          { path: "location.city", raw: joined(loc.city, loc.province) },
        ],
        countryFields: [
          { path: "location.country_code", raw: loc.country_code ?? loc.country },
          { path: "location.name", raw: countryName },
        ],
        structuredType: label(j.employment_type) ?? label(j.employment_type_text),
        posted_at: date(label(j.published_at)),
        updated_at: null,
        remote: { workplaceType: j.workplace_type },
      };
    }
    case "teamtailor": {
      // JSON Feed 1.1 item with a `_jobposting` schema.org JobPosting
      // extension (description, datePosted, jobLocation[].address).
      const posting = object(j._jobposting);
      const places = (Array.isArray(posting.jobLocation) ? posting.jobLocation : posting.jobLocation ? [posting.jobLocation] : []).map(object);
      return {
        ...base,
        url: text(j.url),
        description: html(j.content_html) ?? html(posting.description),
        locationFields: places.map((p, i) => ({ path: `_jobposting.jobLocation[${i}].address.addressLocality`, raw: object(p.address).addressLocality })),
        countryFields: places.map((p, i) => ({ path: `_jobposting.jobLocation[${i}].address.addressCountry`, raw: object(p.address).addressCountry })),
        structuredType: label(posting.employmentType),
        posted_at: date(j.date_published) ?? date(posting.datePosted),
        updated_at: date(j.date_modified),
        remote: { isRemote: posting.jobLocationType === "TELECOMMUTE" ? true : undefined },
      };
    }
    case "usajobs": {
      // Search API item: MatchedObjectId (control number) + descriptor.
      // Country comes from PositionLocation[].CountryCode (a country name);
      // the type from PositionOfferingType (internships/temporary) before
      // PositionSchedule (full/part-time); posted_at is PublicationStartDate.
      const d = object(j.MatchedObjectDescriptor),
        details = object(object(d.UserArea).Details);
      const locations = array(d.PositionLocation).map(object);
      const typeLabels = [...array(d.PositionOfferingType), ...array(d.PositionSchedule)]
        .map((t) => label(object(t).Name))
        .filter((v): v is string => v !== null);
      return {
        ...base,
        uid: identity(j.MatchedObjectId),
        title: text(d.PositionTitle),
        url: text(d.PositionURI) ?? text(array(d.ApplyURI)[0]),
        description: sections([
          html(details.JobSummary),
          { heading: "Duties", body: sections(array(details.MajorDuties).map(html)) },
          { heading: "Requirements", body: html(details.Requirements) },
          { heading: "Qualifications", body: html(d.QualificationSummary) },
          { heading: "Education", body: html(details.Education) },
          { heading: "How to apply", body: html(details.HowToApply) },
        ]),
        locationFields: [
          { path: "PositionLocationDisplay", raw: d.PositionLocationDisplay },
          ...locations.map((l, i) => ({ path: `PositionLocation[${i}].LocationName`, raw: l.LocationName })),
        ],
        countryFields: locations.map((l, i) => ({ path: `PositionLocation[${i}].CountryCode`, raw: l.CountryCode })),
        structuredType: typeLabels.find((v) => employmentType(v)) ?? typeLabels[0] ?? null,
        posted_at: unzonedDate(d.PublicationStartDate),
        updated_at: null,
        remote: { isRemote: details.RemoteIndicator === true ? true : undefined },
      };
    }
  }
}
function normalizeJob(ats: PrimaryAts, slug: string, raw: unknown): SourceJob {
  const j = object(raw),
    issues: string[] = [];
  const x = extract(ats, j);
  const { uid, title, url } = x;
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
  let description = x.description;
  const originalDescription = description;
  if (description?.includes("\0")) {
    description = description.replaceAll("\0", "");
    issues.push("description:nul-removed-in-readable-copy-original-retained");
  }
  const locations = x.locationFields.map((field) => field.raw);
  const evidence = x.countryFields.filter(
      (f) => f.raw !== null && f.raw !== undefined,
    );
  let countries = [
    ...new Set(
      evidence
        .map((f) => explicitCountry(f.raw))
        .filter((v): v is string => v !== null),
    ),
  ];
  for (const f of evidence)
    if (!explicitCountry(f.raw)) issues.push(`country:unrecognized:${f.path}`);
  // USAJOBS is the US federal source: an announcement whose location list
  // names no recognisable country is still a US federal position.
  let countryMethod: Record<string, unknown> = {};
  if (ats === "usajobs" && !countries.length) {
    countries = ["US"];
    countryMethod = { country_method: "source-default", default_country: "US" };
  }
  const worldwide = worldwideEvidence([...x.locationFields, ...x.countryFields], x.remote);
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
    posted_at: x.posted_at,
    updated_at: x.updated_at,
    structuredType: x.structuredType,
    structured_job_type: employmentType(x.structuredType),
    description,
    description_complete:
      Boolean(originalDescription?.trim()) &&
      description === originalDescription,
    country_codes: countries,
    country_evidence: {
      source: `${ats}-api`,
      fieldPaths: evidence.map((f) => f.path),
      rawValues: evidence.map((f) => f.raw),
      ...countryMethod,
      ...(worldwide ? { remote_scope: "worldwide", worldwide_evidence: worldwide } : {}),
    },
    is_publicly_listed: x.listed,
    source_record_json: rawJson,
    source_content_sha256: createHash("sha256").update(rawJson).digest("hex"),
    issues,
  };
}
/** Where each provider keeps its records in a board response. */
function boardRows(ats: PrimaryAts, data: unknown): unknown {
  const wrapper = object(data);
  switch (ats) {
    case "lever":
    case "breezy":
      return data;
    case "recruitee":
      return wrapper.offers;
    case "pinpoint":
      return wrapper.data;
    case "teamtailor":
      return wrapper.items;
    case "usajobs":
      return object(wrapper.SearchResult).SearchResultItems;
    default:
      return wrapper.jobs;
  }
}
export function parseBoardResponse(
  ats: PrimaryAts,
  slug: string,
  data: unknown,
): SourceJob[] & { skippedMalformed?: number } {
  const wrapper = object(data),
    rows = boardRows(ats, data);
  if (!Array.isArray(rows)) throw new CollectionError("MALFORMED_BOARD");
  if (
    ats === "greenhouse" &&
    (!Number.isSafeInteger(object(wrapper.meta).total) ||
      object(wrapper.meta).total !== rows.length)
  )
    throw new CollectionError("INCOMPLETE_BOARD");
  // Whole-board feeds must not page. `next_url` is JSON Feed pagination
  // (Teamtailor); USAJOBS pages explicitly through fetchPrimaryBoard.
  for (const key of [
    "next",
    "nextPage",
    "nextCursor",
    "hasMore",
    "hasNextPage",
    "next_url",
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
const dnsLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const hostName = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export function boardUrl(ats: PrimaryAts, slug: string, eu = false): string {
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(slug))
    throw new CollectionError("INVALID_BOARD");
  const board = encodeURIComponent(slug);
  switch (ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
    case "lever":
      return `https://api.${eu ? "eu." : ""}lever.co/v0/postings/${board}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${board}`;
    case "workable":
      return `https://apply.workable.com/api/v1/widget/accounts/${board}?details=true`;
    case "usajobs":
      // One USAJOBS board is one search. The registry token "all" is the
      // whole announcement set; any other token narrows by agency
      // subelement code (`Organization=`) so a board stays under the API's
      // 10,000-row query ceiling.
      return `https://data.usajobs.gov/api/Search?ResultsPerPage=500&Fields=Full${slug.toLowerCase() === "all" ? "" : `&Organization=${board}`}`;
    case "teamtailor":
      // The board token is the career-site host (custom domains).
      if (!hostName.test(slug)) throw new CollectionError("INVALID_BOARD");
      return `https://${slug.toLowerCase()}/jobs.json`;
    default:
      // Tenant subdomains: the token must be a single DNS label so it cannot
      // address a different host.
      if (!dnsLabel.test(slug)) throw new CollectionError("INVALID_BOARD");
      return ats === "recruitee"
        ? `https://${slug.toLowerCase()}.recruitee.com/api/offers/`
        : ats === "breezy"
          ? `https://${slug.toLowerCase()}.breezy.hr/json`
          : `https://${slug.toLowerCase()}.pinpointhq.com/postings.json`;
  }
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
/** One bounded GET: forbidden redirects, whole-body deadline, byte cap,
 * content-type gate. Returns the raw bytes; callers decode. */
async function boundedBody(
  url: string,
  fetcher: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
  expect: { accept: string; contentType: (type: string) => boolean; failure: string },
  headers: Record<string, string> = {},
): Promise<Buffer> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await abortable(
      fetcher(url, {
        signal: controller.signal,
        redirect: "error",
        headers: {
          "User-Agent": "Corveno corpus (hello@corveno.io)",
          Accept: expect.accept,
          ...headers,
        },
      }),
      controller.signal,
    );
    if (!response.ok) throw new CollectionError(`HTTP_${response.status}`);
    if (response.status === 206 || response.headers.has("content-range"))
      throw new CollectionError("PARTIAL_RESPONSE");
    if (!expect.contentType(response.headers.get("content-type") ?? ""))
      throw new CollectionError(expect.failure);
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
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}
export async function boundedJson(
  url: string,
  fetcher: typeof fetch = fetch,
  maxBytes = 25165824,
  timeoutMs = 30000,
  allowPlainJson = false,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const body = await boundedBody(
    url,
    fetcher,
    maxBytes,
    timeoutMs,
    {
      accept: "application/json",
      contentType: (type) =>
        /\bjson\b/i.test(type) || (allowPlainJson && /^text\/plain\b/i.test(type)),
      failure: "NOT_JSON",
    },
    headers,
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new CollectionError("INVALID_JSON");
  }
}
/** Bounded HTML page read (Breezy position pages). */
export async function boundedHtml(
  url: string,
  fetcher: typeof fetch = fetch,
  maxBytes = 1048576,
  timeoutMs = 30000,
): Promise<string> {
  const body = await boundedBody(url, fetcher, maxBytes, timeoutMs, {
    accept: "text/html",
    contentType: (type) => /^text\/html\b/i.test(type),
    failure: "NOT_HTML",
  });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new CollectionError("INVALID_ENCODING");
  }
}
/** The `<div class="description">…</div>` block of a Breezy position page,
 * found by tag depth so nested markup stays inside. Null when absent. */
export function breezyPageDescription(page: string): string | null {
  const open = /<div\b[^>]*\bclass=["'](?:[^"']*\s)?description(?:\s[^"']*)?["'][^>]*>/i.exec(page);
  if (!open) return null;
  const start = open.index + open[0].length;
  const tag = /<\/?div\b[^>]*>/gi;
  tag.lastIndex = start;
  for (let depth = 1, m = tag.exec(page); m; m = tag.exec(page)) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) return page.slice(start, m.index);
  }
  return null;
}
/* Breezy position pages: one bounded GET per position on the board's own
 * host, at most this many positions/bytes per board and this many at once. */
const BREEZY_MAX_POSITIONS = 200,
  BREEZY_MAX_PAGE_BYTES = 1048576,
  BREEZY_MAX_BOARD_BYTES = 16777216,
  BREEZY_BOARD_TIMEOUT_MS = 120000,
  BREEZY_CONCURRENCY = 4;
async function breezyWithDescriptions(
  slug: string,
  rows: unknown[],
  fetcher: typeof fetch,
  started: number,
): Promise<unknown[]> {
  if (rows.length > BREEZY_MAX_POSITIONS) throw new CollectionError("TOO_MANY_JOBS");
  const host = `${slug.toLowerCase()}.breezy.hr`;
  const out: unknown[] = new Array(rows.length);
  let bytes = 0,
    next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= rows.length) return;
      const row = object(rows[index]);
      let pageUrl: URL | null = null;
      try {
        pageUrl = new URL(String(row.url));
      } catch {
        pageUrl = null;
      }
      if (!pageUrl || pageUrl.protocol !== "https:" || pageUrl.host !== host) {
        // Malformed rows are counted by parseBoardResponse; a foreign host is
        // never fetched and the record keeps a null description.
        out[index] = rows[index];
        continue;
      }
      const remaining = BREEZY_BOARD_TIMEOUT_MS - (Date.now() - started);
      if (remaining <= 0) throw new CollectionError("BOARD_TIMEOUT");
      let page: string | null = null;
      try {
        page = await boundedHtml(pageUrl.href, fetcher, BREEZY_MAX_PAGE_BYTES, Math.min(30000, remaining));
      } catch (error) {
        // A position that vanished between the list and its page read keeps
        // a null description this cycle; every other failure fails the board.
        if (!(error instanceof CollectionError && (error.code === "HTTP_404" || error.code === "HTTP_410"))) throw error;
      }
      if (page !== null) {
        bytes += Buffer.byteLength(page, "utf8");
        if (bytes > BREEZY_MAX_BOARD_BYTES) throw new CollectionError("BOARD_TOO_LARGE");
      }
      out[index] = { ...row, position_page_description: page === null ? null : breezyPageDescription(page) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(BREEZY_CONCURRENCY, rows.length) }, worker));
  return out;
}
/* USAJOBS: 500 rows per page, 10,000 rows per query (API ceiling), explicit
 * page count in SearchResult.UserArea.NumberOfPages. */
const USAJOBS_PAGE_ROWS = 500,
  USAJOBS_MAX_ROWS = 10000,
  USAJOBS_MAX_BOARD_BYTES = 134217728,
  USAJOBS_BOARD_TIMEOUT_MS = 300000;
/* Teamtailor career sites serve JSON Feed 1.1 pages of 100 items linked by
 * `next_url` (a Footasylum feed had 100 items + next_url on 2026-09-16). The
 * pages are followed only on the board's own host and path, under a page,
 * byte and time bound, and merged into one whole-board wrapper without
 * `next_url` so the whole-board rules in parseBoardResponse still apply. */
const TEAMTAILOR_MAX_PAGES = 25,
  TEAMTAILOR_MAX_BYTES = 25165824,
  TEAMTAILOR_TIMEOUT_MS = 60000;
export async function teamtailorPages(
  url: string,
  fetcher: typeof fetch = fetch,
  started = Date.now(),
): Promise<Record<string, unknown>> {
  const first = new URL(url);
  const items: unknown[] = [];
  let next: string | null = url,
    bytes = 0,
    wrapper: Record<string, unknown> = {};
  for (let page = 1; next; page++) {
    if (page > TEAMTAILOR_MAX_PAGES) throw new CollectionError("INCOMPLETE_BOARD");
    if (Date.now() - started > TEAMTAILOR_TIMEOUT_MS) throw new CollectionError("BOARD_TIMEOUT");
    const body = object(
      await boundedJson(next, fetcher, 8388608, Math.min(30000, TEAMTAILOR_TIMEOUT_MS - (Date.now() - started))),
    );
    if (!Array.isArray(body.items)) throw new CollectionError("MALFORMED_BOARD");
    bytes += Buffer.byteLength(JSON.stringify(body.items));
    if (bytes > TEAMTAILOR_MAX_BYTES) throw new CollectionError("BOARD_TOO_LARGE");
    if (page === 1) wrapper = { ...body };
    items.push(...body.items);
    const link = typeof body.next_url === "string" ? body.next_url : null;
    if (link) {
      let target: URL;
      try {
        target = new URL(link);
      } catch {
        throw new CollectionError("UNEXPECTED_PAGINATION");
      }
      // Only the same career site's own feed may continue the listing.
      if (target.protocol !== "https:" || target.host !== first.host || target.pathname !== first.pathname)
        throw new CollectionError("UNEXPECTED_PAGINATION");
      if (body.items.length === 0) throw new CollectionError("UNSTABLE_PAGINATION");
    }
    next = link;
  }
  const { next_url: _dropped, ...rest } = wrapper;
  return { ...rest, items };
}
export async function fetchPrimaryBoard(
  ats: PrimaryAts,
  slug: string,
  fetcher: typeof fetch = fetch,
  eu = false,
  credentials: UsajobsCredentials | null = null,
): Promise<{ jobs: SourceJob[]; checkedAt: string; sourceUrl: string; skippedMalformed: number }> {
  const url = boardUrl(ats, slug, eu),
    started = Date.now();
  const snapshot = (parsed: SourceJob[] & { skippedMalformed?: number }) => ({
    jobs: parsed as SourceJob[],
    skippedMalformed: parsed.skippedMalformed ?? 0,
    checkedAt: new Date().toISOString(),
    sourceUrl: url,
  });
  if (ats === "breezy") {
    const list = await boundedJson(url, fetcher);
    if (!Array.isArray(list)) throw new CollectionError("MALFORMED_BOARD");
    return snapshot(parseBoardResponse(ats, slug, await breezyWithDescriptions(slug, list, fetcher, started)));
  }
  if (ats === "teamtailor")
    return snapshot(parseBoardResponse(ats, slug, await teamtailorPages(url, fetcher, started)));
  if (ats !== "lever" && ats !== "usajobs")
    return snapshot(parseBoardResponse(ats, slug, await boundedJson(url, fetcher)));
  const usajobs = ats === "usajobs" ? (credentials ?? usajobsCredentials()) : null;
  if (ats === "usajobs" && !usajobs) throw new CollectionError("USAJOBS_CREDENTIALS_MISSING");
  const headers: Record<string, string> = usajobs
    ? { Host: "data.usajobs.gov", "User-Agent": usajobs.userAgent, "Authorization-Key": usajobs.apiKey }
    : {};
  const deadline = ats === "usajobs" ? USAJOBS_BOARD_TIMEOUT_MS : 60000,
    maxBytes = ats === "usajobs" ? USAJOBS_MAX_BOARD_BYTES : 25165824;
  let skippedMalformed = 0;
  const jobs: SourceJob[] = [],
    ids = new Set<string>();
  let bytes = 0;
  for (let skip = 0, page = 1; skip <= 50000; page++) {
    if (Date.now() - started > deadline)
      throw new CollectionError("BOARD_TIMEOUT");
    const pageUrl = ats === "usajobs" ? `${url}&Page=${page}` : `${url}&limit=100&skip=${skip}`;
    const body = await boundedJson(
      pageUrl,
      fetcher,
      ats === "usajobs" ? 25165824 : 8388608,
      Math.min(30000, deadline - (Date.now() - started)),
      false,
      headers,
    );
    const normalized = parseBoardResponse(ats, slug, body);
    skippedMalformed += normalized.skippedMalformed ?? 0;
    if (normalized.length > (ats === "usajobs" ? USAJOBS_PAGE_ROWS : 100))
      throw new CollectionError("PAGINATION_IGNORED");
    for (const job of normalized) {
      if (ids.has(job.uid)) throw new CollectionError("UNSTABLE_PAGINATION");
      ids.add(job.uid);
      jobs.push(job);
      bytes += Buffer.byteLength(job.source_record_json);
      if (bytes > maxBytes) throw new CollectionError("BOARD_TOO_LARGE");
    }
    if (ats === "usajobs") {
      // The API caps a query at 10,000 rows; a larger result set can never be
      // a complete snapshot, so it fails rather than closing what it missed.
      const result = object(object(body).SearchResult);
      const total = Number(result.SearchResultCountAll),
        pages = Number(object(result.UserArea).NumberOfPages);
      if (Number.isFinite(total) && total > USAJOBS_MAX_ROWS) throw new CollectionError("INCOMPLETE_BOARD");
      // Stop only on the reported last page or an empty page, never on a
      // short intermediate page.
      const rawRows = array(result.SearchResultItems).length;
      if (rawRows === 0 || (Number.isFinite(pages) && page >= pages))
        return { jobs, checkedAt: new Date().toISOString(), sourceUrl: url, skippedMalformed };
      skip += rawRows;
      continue;
    }
    if (normalized.length === 0)
      return { jobs, checkedAt: new Date().toISOString(), sourceUrl: url, skippedMalformed };
    skip += normalized.length;
  }
  throw new CollectionError("TOO_MANY_JOBS");
}
