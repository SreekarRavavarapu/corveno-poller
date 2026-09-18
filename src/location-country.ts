/**
 * Deterministic country resolution for job-location labels (jobs plan Phase 1
 * item 1.5, Sep 17 2026). One entry point used by the collector, the
 * re-resolve backfill and the enrichment consumer, composing:
 *
 *  1. explicit launch-market labels and exclusions (./country-evidence.ts):
 *     "United Kingdom", "Remote - US", "Canada (not Quebec)";
 *  2. remote-scoped short labels without a separator: "US Remote",
 *     "Remote US", "Remote in USA", "Fully Remote - Based in USA";
 *  3. the seven-market gazetteer (./location-gazetteer.ts): cities, regions,
 *     region codes, anchor-only localities, "<place>, OH" shape;
 *  4. explicit country names outside the markets ("Germany", "Deutschland",
 *     "Remote - Colombia") and a curated list of unambiguous world cities
 *     ("Berlin", "Seoul", "São Paulo"), recorded so the row leaves the
 *     "unknown" pool but never routes to a launch market.
 *
 * Guarantees
 * - Every country carries a quote (the location unit it was read from), a
 *   confidence and the method; nothing is inferred from company, applicant
 *   or language.
 * - Regions and scopes (EMEA, APAC, LATAM, Europe, Global, Anywhere) and a
 *   bare "Remote"/"Hybrid" never become a country; they are reported as a
 *   scope so the consumer can tell "unknown" from "deliberately unscoped".
 * - A unit whose evidence points at two countries at once ("Toronto, TX",
 *   "Toronto, USA") contributes nothing (conflict). Separate units joined by
 *   ";", "|" or "/" are independent and their countries are unioned.
 * - World cities count only when the unit holds no market evidence, no
 *   ambiguous market name and no market region code ("Hanover, MD" is not
 *   Hannover; "Berlin, CT" is Connecticut).
 */
import { explicitCountryAlias, locationCountryEvidence, supportedMarketCodes, type SupportedMarket } from "./country-evidence";
import { gazetteerCountryEvidence, type GazetteerMatch } from "./location-gazetteer";
import { gazetteerSource } from "./location-gazetteer-data";
import { regionScopeLabels, remoteWordPattern, worldCities, worldCountryAliases, worldCountryBlocklist } from "./location-country-data";

export type LocationCountryMethod = "explicit-label" | "remote-country" | "gazetteer" | "world-country" | "world-city";
export type LocationCountryConfidence = "high" | "medium";
export interface LocationCountryItem {
  country: string;
  /** The location unit the country was read from, verbatim (at most 200 characters). */
  quote: string;
  confidence: LocationCountryConfidence;
  kind: "explicit" | "world-country" | "world-city" | GazetteerMatch["kind"];
  method: LocationCountryMethod;
  /** The unit carried a remote/hybrid word ("Remote - US", "Germany, Remote"). */
  remote?: true;
}
export interface LocationCountryResolution {
  /** ISO2 codes, first-seen order across units; empty when nothing deterministic applies. */
  countries: string[];
  /** Method of the first evidence item (what produced the first country). */
  method: LocationCountryMethod | null;
  evidence: LocationCountryItem[];
  /** Markets the label explicitly excludes ("not Quebec"). */
  excluded: string[];
  /** Gazetteer names left unresolved because they could belong to more than one country. */
  ambiguous: string[];
  /** Some unit pointed at two countries at once; that unit contributed nothing. */
  conflict: boolean;
  /** "remote-country": a remote label scoped to the resolved countries; "region": a continent/region/scope label (no country). */
  location_scope: "remote-country" | "region" | null;
  scope_quote: string | null;
  unresolved_reason: "empty" | "bare-remote" | "region" | "ambiguous" | "conflict" | "unknown" | null;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
const markets = new Set<string>(supportedMarketCodes);
/** NFKC → casefold → strip combining marks → "&" → "and" → drop periods/apostrophes → punctuation to spaces. */
export function normalizeLocationSegment(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/&/g, " and ")
    .replace(/[.'’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
const marketShortLabels: Record<string, SupportedMarket> = {
  us: "US", usa: "US", "u s": "US", "u s a": "US", "united states": "US", "united states of america": "US", "the united states": "US", "the us": "US", "the usa": "US",
  uk: "GB", "u k": "GB", gb: "GB", gbr: "GB", "united kingdom": "GB", "great britain": "GB", "the uk": "GB", "the united kingdom": "GB",
  can: "CA", canada: "CA", au: "AU", aus: "AU", australia: "AU", sg: "SG", sgp: "SG", singapore: "SG", jp: "JP", jpn: "JP", japan: "JP", india: "IN",
};
/** Explicit country names outside the markets: CLDR English display names + aliases − blocklist − markets − territories. */
const worldCountries = new Map<string, string>();
{
  const display = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const deprecated = new Set("AC AN BU CP CS DD DG EA EU EZ FX IC NT QO SU TA TP UN XA XB YD YU ZR ZZ".split(" "));
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = deprecated.has(code) || markets.has(code) ? null : display.of(code);
      if (name && name !== code) worldCountries.set(normalizeLocationSegment(name), code);
    }
  for (const [alias, code] of Object.entries(worldCountryAliases)) if (!markets.has(code)) worldCountries.set(normalizeLocationSegment(alias), code);
  for (const name of worldCountryBlocklist) worldCountries.delete(normalizeLocationSegment(name));
}
const worldCityTable = new Map<string, string>(Object.entries(worldCities).map(([name, code]) => [normalizeLocationSegment(name), code]));
const regionScope = new Set<string>(regionScopeLabels.map(normalizeLocationSegment));
const marketRegionCodes = new Set<string>(supportedMarketCodes.flatMap((code) => gazetteerSource[code].regionCodes));
const remoteWord = new RegExp(remoteWordPattern, "iu");
const leadingRemote = new RegExp(`^${remoteWordPattern}\\s*(?:in|from|within|across|throughout|based\\s+in|based|only|-|–|—|:|,)?\\s*(?:the\\s+)?`, "iu");
const trailingRemote = new RegExp(`\\s*(?:-|–|—|,|\\|)?\\s*\\(?\\s*${remoteWordPattern}\\s*\\)?\\s*$`, "iu");
const leadingBased = /^(?:based\s+in|located\s+in|office\s+in|offices\s+in|anywhere\s+in|based|located|in)\s+(?:the\s+)?/iu;
const trailingSite = /\s+(?:office|offices|hq|headquarters|campus|site|plant|branch|hub|studio|lab|labs|center|centre)$/iu;
const districtNumber = /^\d{3,7}\s+|\s+\d{1,7}$/gu;
const negative = /\b(?:not|except|excluding|excluded|outside|sauf|hors|exclu(?:e|s|es)?)\b|以外|除外|対象外|除く|不包括|不含|बाहर/iu;
const unitSplit = /[;|\n]+|\s*\/\s*/u;
const segmentSplit = /[,()（）、:>]+|\s+[-–—]+\s+|\s+(?:or|and|&|\+)\s+/iu;
const quoteOf = (unit: string): string => unit.trim().replace(/\s+/g, " ").slice(0, 200);

function stripRemote(segment: string): { core: string; remote: boolean } {
  let core = segment.trim();
  let remote = false;
  for (let pass = 0; pass < 2; pass++) {
    const before = core;
    core = core.replace(leadingRemote, "").trim();
    core = core.replace(trailingRemote, "").trim();
    if (core !== before) remote = true;
  }
  core = core.replace(leadingBased, "").trim().replace(/^[-–—:\s]+|[-–—:\s]+$/g, "");
  core = core.replace(trailingSite, "").replace(districtNumber, "").trim();
  if (!remote && remoteWord.test(segment)) remote = true;
  return { core, remote };
}

interface WorldItem extends LocationCountryItem { segment: string }
interface UnitReading {
  quote: string;
  remote: boolean;
  region: boolean;
  regionQuote: string | null;
  marketCoded: boolean;
  explicit: LocationCountryItem[];
  world: WorldItem[];
}
function readUnit(unit: string): UnitReading {
  const quote = quoteOf(unit);
  const reading: UnitReading = { quote, remote: false, region: false, regionQuote: null, marketCoded: false, explicit: [], world: [] };
  const denied = negative.test(unit);
  for (const rawSegment of unit.split(segmentSplit)) {
    const segment = rawSegment.trim().replace(/^[-–—\s]+|[-–—\s]+$/g, "");
    if (!segment) continue;
    const { core, remote } = stripRemote(segment);
    if (remote) reading.remote = true;
    const norm = normalizeLocationSegment(core);
    if (!norm) continue;
    if (/^[A-Z]{2,3}$/.test(core.normalize("NFKC").replace(/\./g, "")) && marketRegionCodes.has(core.normalize("NFKC").replace(/\./g, ""))) reading.marketCoded = true;
    if (denied) continue;
    const market = explicitCountryAlias(core) ?? marketShortLabels[norm] ?? null;
    if (market) {
      reading.explicit.push({ country: market, quote, confidence: "high", kind: "explicit", method: remote ? "remote-country" : "explicit-label" });
      continue;
    }
    const country = worldCountries.get(norm);
    if (country) {
      reading.world.push({ country, quote, confidence: "high", kind: "world-country", method: "world-country", segment: core });
      continue;
    }
    const city = worldCityTable.get(norm);
    if (city) {
      reading.world.push({ country: city, quote, confidence: "medium", kind: "world-city", method: "world-city", segment: core });
      continue;
    }
    if (regionScope.has(norm)) {
      reading.region = true;
      reading.regionQuote ??= quote;
    }
  }
  return reading;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
export function resolveLocationCountries(locations: readonly unknown[]): LocationCountryResolution {
  const result: LocationCountryResolution = { countries: [], method: null, evidence: [], excluded: [], ambiguous: [], conflict: false, location_scope: null, scope_quote: null, unresolved_reason: null };
  const labels = (Array.isArray(locations) ? locations : []).filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  if (!labels.length) {
    result.unresolved_reason = "empty";
    return result;
  }
  const excluded = new Set<string>();
  const ambiguous = new Set<string>();
  let sawRemote = false, sawRegion = false, regionQuote: string | null = null, resolvedRemote = false;
  const push = (item: LocationCountryItem) => {
    const { segment: _segment, ...clean } = item as LocationCountryItem & { segment?: string };
    void _segment;
    item = clean;
    result.evidence.push(item);
    if (!result.countries.includes(item.country)) result.countries.push(item.country);
  };
  for (const label of labels) {
    for (const rawUnit of label.normalize("NFKC").split(unitSplit)) {
      const unit = rawUnit.trim();
      if (!unit) continue;
      const reading = readUnit(unit);
      const labelEvidence = locationCountryEvidence([unit]);
      for (const code of labelEvidence.excludedCountries) excluded.add(code);
      const gazetteer = gazetteerCountryEvidence(unit);
      for (const name of gazetteer.ambiguous) ambiguous.add(name);
      if (reading.remote) sawRemote = true;
      if (reading.region) { sawRegion = true; regionQuote ??= reading.regionQuote; }
      // Explicit market labels win over a gazetteer conflict (the
      // combineCountryEvidence precedent): "Orangeville, Utah, United States"
      // is US even though Orangeville is also an Ontario town, "Toronto, USA"
      // is US. Without a conflict the two readers are unioned ("New York, NY,
      // London, UK"); a conflict with no explicit label contributes nothing.
      const explicit: LocationCountryItem[] = [...reading.explicit];
      for (const code of labelEvidence.countries)
        if (!explicit.some((item) => item.country === code)) explicit.push({ country: code, quote: reading.quote, confidence: "high", kind: "explicit", method: reading.remote ? "remote-country" : "explicit-label" });
      const explicitCodes = new Set(explicit.map((item) => item.country));
      const gazetteerItems: LocationCountryItem[] = gazetteer.conflict ? [] : gazetteer.matches.map((match) => ({ country: match.country, quote: reading.quote, confidence: match.confidence, kind: match.kind, method: "gazetteer" as const }));
      void explicitCodes;
      let marketItems = gazetteer.conflict ? explicit : [...explicit, ...gazetteerItems];
      marketItems = marketItems.filter((item) => !excluded.has(item.country));
      if (!explicit.length && gazetteer.conflict) { result.conflict = true; continue; }
      const unitCountries = new Set<string>();
      const add = (item: LocationCountryItem) => {
        if (result.evidence.some((seen) => seen.country === item.country && seen.quote === item.quote && seen.kind === item.kind)) { unitCountries.add(item.country); return; }
        push(reading.remote ? { ...item, remote: true } : item);
        unitCountries.add(item.country);
      };
      for (const item of marketItems) add(item);
      // Explicit non-market country names stand beside explicit market labels
      // ("UK & Ireland") but never beside a gazetteer reading of the same unit
      // ("Peru, IN" is Indiana, "Mexico, MO" is Missouri).
      const gazetteerTokens = new Set(gazetteer.matches.map((match) => normalizeLocationSegment(match.token)));
      const worldCountriesHere = gazetteer.countries.length ? [] : reading.world.filter((item) => item.kind === "world-country" && !gazetteerTokens.has(normalizeLocationSegment(item.segment)));
      // World cities only when nothing in the unit reads as a market place, name or code.
      const worldCitiesHere = marketItems.length || worldCountriesHere.length || reading.marketCoded || gazetteer.ambiguous.length ? [] : reading.world.filter((item) => item.kind === "world-city");
      const world = worldCountriesHere.length ? worldCountriesHere : worldCitiesHere;
      if (new Set(world.map((item) => item.country)).size > 1) { result.conflict = true; continue; }
      for (const item of world) add(item);
      if (unitCountries.size && reading.remote) resolvedRemote = true;
    }
  }
  result.excluded = [...excluded];
  result.ambiguous = [...ambiguous];
  result.method = result.evidence[0]?.method ?? null;
  if (result.countries.length) {
    if (resolvedRemote) result.location_scope = "remote-country";
    return result;
  }
  if (sawRegion) { result.location_scope = "region"; result.scope_quote = regionQuote; result.unresolved_reason = "region"; }
  else if (result.conflict) result.unresolved_reason = "conflict";
  else if (ambiguous.size) result.unresolved_reason = "ambiguous";
  else if (sawRemote && labels.every((label) => !normalizeLocationSegment(stripRemote(label).core))) result.unresolved_reason = "bare-remote";
  else result.unresolved_reason = "unknown";
  return result;
}

/**
 * The country_evidence fields the collector and the backfill write next to
 * `country_codes` for a label-derived resolution. Keys already used by rows
 * written before Sep 17 2026 (`gazetteer_ambiguous`, `country_method`) keep
 * their names; `location_evidence` carries the quote per country.
 */
export function locationCountryEvidenceFields(resolution: LocationCountryResolution): Record<string, unknown> {
  return {
    ...(resolution.countries.length ? { country_method: resolution.method, location_evidence: resolution.evidence } : {}),
    ...(resolution.ambiguous.length ? { gazetteer_ambiguous: resolution.ambiguous } : {}),
    ...(resolution.conflict ? { gazetteer_conflict: true } : {}),
    ...(resolution.excluded.length ? { excluded_countries: resolution.excluded } : {}),
    ...(resolution.location_scope ? { location_scope: resolution.location_scope } : {}),
    ...(resolution.scope_quote ? { location_scope_quote: resolution.scope_quote } : {}),
    ...(!resolution.countries.length && resolution.unresolved_reason ? { location_unresolved: resolution.unresolved_reason } : {}),
  };
}
