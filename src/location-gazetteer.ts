/**
 * Conservative, deterministic city/region → country evidence for the seven
 * launch markets. Complements ./country-evidence.ts (explicit country labels)
 * for job-location strings that name only a city, state/province/prefecture
 * or metro ("Bengaluru", "Toronto, ON", "Sydney NSW", "東京都",
 * "Remote - Karnataka").
 *
 * Guarantees
 * - Whole-token / whole-phrase matching only; never substrings ("Bathurst"
 *   cannot match "Bath"). Japanese tokens may carry a ward/city suffix
 *   ("東京都港区" matches 東京都 because the remainder ends in 区).
 * - A name that could belong to more than one country — inside the seven
 *   markets or against a well-known place elsewhere — is never positive on its
 *   own. It resolves only when a region, region code or explicit country of
 *   one candidate sits in the same location ("Cambridge, MA"; "Perth, WA";
 *   "London, Ontario"), and then at high confidence.
 * - Region codes count only in upper case; word-like codes (DE, ME, OR, IN,
 *   ON …) only directly after a known city ("Austin, TX") or beside an
 *   explicit country ("US-TX", "TX, USA"). "CA" and "IN" read as both a US
 *   state and a country and never resolve alone.
 * - Segments carrying a negation (not / except / excluding / outside / 以外 …)
 *   contribute nothing, mirroring country-evidence.ts.
 * - Anchor-only localities (location-gazetteer-data.ts `anchorOnlyCities`)
 *   never resolve alone and are never reported as ambiguous; they exist to
 *   anchor a guarded or country-colliding code of their own market
 *   ("Hawthorne, CA" → US, "Hawthorne" → nothing).
 * - In the two-segment shape "<unknown place>, <CODE>" a word-like code that
 *   belongs to one market and collides with no country (`shapeSafeRegionCodes`:
 *   OR, HI, OK, OH, ON, MB, NB, ACT) resolves at medium confidence.
 * - Two anchored countries inside ONE location ("Toronto, TX") → every country
 *   is returned with `conflict: true`. Separate locations joined by ";", "|"
 *   or "/" are independent ("Toronto, ON; Austin, TX" → CA and US, no
 *   conflict) — the consumer joins a listing's locations with " ; ".
 */
import { explicitCountryAlias, supportedMarketCodes, type SupportedMarket } from "./country-evidence";
import {
  anchorOnlyCities,
  anchorRequiredCodeCountries,
  countryCollisionCodes,
  gazetteerModifiers,
  gazetteerSource,
  guardedRegionCodes,
  shapeSafeRegionCodes,
  type GazetteerKind,
} from "./location-gazetteer-data";

export type GazetteerConfidence = "high" | "medium";
export interface GazetteerMatch { token: string; country: string; kind: GazetteerKind; confidence: GazetteerConfidence }
export interface GazetteerCountryEvidence {
  /** Countries positively evidenced (ISO2), first-seen order. Empty when only ambiguous names were found. */
  countries: string[];
  matches: GazetteerMatch[];
  /** Names seen but left unresolved because they could belong to more than one country. */
  ambiguous: string[];
  /** Two different countries were anchored inside one location. */
  conflict: boolean;
}

// ---------------------------------------------------------------------------
// Normalisation and tokenisation
// ---------------------------------------------------------------------------
const markets = new Set<string>(supportedMarketCodes);
const isMarket = (code: string): code is SupportedMarket => markets.has(code);
/** NFKC → casefold → strip Latin combining marks (U+0300–U+036F only, so kana
 * voicing marks survive) → drop periods/apostrophes ("St." → "st", "D.C." → "dc"). */
const normalizeToken = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("en-US").normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC").replace(/[.'’`]/g, "");
/** Whitespace, hyphens, dashes and "&" separate tokens inside a segment. */
const tokenPattern = /[^\s\-–—&,;/|()（）、]+/gu;
interface Token { text: string; norm: string; start: number; end: number }
function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  for (const match of segment.matchAll(tokenPattern)) {
    const norm = normalizeToken(match[0]);
    if (norm) tokens.push({ text: match[0], norm, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return tokens;
}
const phraseKey = (value: string): string => tokenize(value.normalize("NFKC")).map((token) => token.norm).join(" ");
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** A Japanese token may end in a ward/city/town/village/district suffix after the place name. */
const cjkSuffix = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{0,8}[区市町村郡]$/u;
/** Mirrors country-evidence.ts: a segment carrying any of these forms is never positive. */
const negative = /\b(?:not|except|excluding|excluded|outside|sauf|hors|exclu(?:e|s|es)?)\b|以外|除外|対象外|除く|不包括|不含|बाहर/iu;
/** Mirrors the short labels country-evidence.ts accepts; "CA" and "IN" are deliberately absent there too. */
const shortLabels: Record<string, SupportedMarket> = { US: "US", USA: "US", UK: "GB", GB: "GB", GBR: "GB", AU: "AU", AUS: "AU", CAN: "CA", SG: "SG", SGP: "SG", JP: "JP", JPN: "JP" };
/** A capitalised word or short phrase of letters only — what an unlisted town looks like. */
const placeLike = /^(?!(?:[Rr]emote|[Hh]ybrid|[Oo]n-?[Ss]ite|[Vv]irtual|[Aa]nywhere|[Ff]lexible|[Hh]ome|[Ww][Ff][Hh])\b)\p{Lu}[\p{L}'’.]*(?:[\s-]\p{L}[\p{L}'’.]*){0,3}$/u;
const unitSeparator = /[;|/\n]+/u;
const segmentSeparator = /[,()（）、]+|\s+[-–—]+\s+/u;

// ---------------------------------------------------------------------------
// Index built once from the curated data
// ---------------------------------------------------------------------------
interface Entry {
  key: string;
  display: string;
  tokenCount: number;
  /** Market candidates with the kinds each country lists the name under. */
  kinds: Map<SupportedMarket, Set<GazetteerKind>>;
  /** Well-known non-market places sharing the name (only affects ambiguity). */
  nonMarket: Set<string>;
  ambiguous: boolean;
  wholeSegmentOnly: boolean;
  defaultCountry: SupportedMarket | null;
  /** Markets that list the name only as an anchor-only locality. */
  anchorOnlyIn: Set<SupportedMarket>;
  /** Every reading is anchor-only: never positive alone, never ambiguous. */
  anchorOnly: boolean;
}
interface CodeEntry {
  code: string;
  countries: Set<SupportedMarket>;
  /** Needs a city or explicit country next to it (word-like, or an Indian state code). */
  guarded: boolean;
  /** Also an ordinary word (OR, IN, ME …): silently ignored when unanchored. */
  wordGuarded: boolean;
  collision: { region: SupportedMarket; country: SupportedMarket } | null;
  /** Word-like, single-market, no country collision: accepted in "<place>, CODE" shape. */
  shapeSafe: boolean;
}

const entries = new Map<string, Entry>();
const codes = new Map<string, CodeEntry>();
let maxTokens = 1;
function entryFor(key: string, display: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { key, display, tokenCount: key.split(" ").length, kinds: new Map(), nonMarket: new Set(), ambiguous: false, wholeSegmentOnly: false, defaultCountry: null, anchorOnlyIn: new Set(), anchorOnly: false };
    entries.set(key, entry);
    maxTokens = Math.max(maxTokens, entry.tokenCount);
  }
  return entry;
}
for (const country of supportedMarketCodes) {
  const data = gazetteerSource[country];
  const lists: [GazetteerKind, string[]][] = [["region", data.regions], ["city", data.cities], ["metro", data.metros]];
  for (const [kind, items] of lists) {
    for (const item of items) {
      for (const form of item.split("|")) {
        const key = phraseKey(form);
        if (!key) continue;
        const entry = entryFor(key, form.trim());
        const kinds = entry.kinds.get(country) ?? new Set<GazetteerKind>();
        kinds.add(kind);
        entry.kinds.set(country, kinds);
      }
    }
  }
  const guardedByCountry = anchorRequiredCodeCountries.includes(country);
  for (const code of data.regionCodes) {
    const upper = code.normalize("NFKC").toUpperCase();
    const existing = codes.get(upper) ?? { code: upper, countries: new Set<SupportedMarket>(), guarded: false, wordGuarded: guardedRegionCodes.includes(upper), collision: null, shapeSafe: false };
    existing.countries.add(country);
    existing.guarded = existing.guarded || guardedByCountry || existing.wordGuarded;
    existing.collision = countryCollisionCodes[upper] ?? null;
    codes.set(upper, existing);
  }
  for (const item of anchorOnlyCities[country]) {
    for (const form of item.split("|")) {
      const key = phraseKey(form);
      if (!key) continue;
      const entry = entryFor(key, form.trim());
      if (!entry.kinds.has(country)) {
        entry.kinds.set(country, new Set(["city"]));
        entry.anchorOnlyIn.add(country);
      }
    }
  }
}
for (const code of codes.values()) code.shapeSafe = shapeSafeRegionCodes.includes(code.code) && code.countries.size === 1 && !code.collision;
for (const [name, modifier] of Object.entries(gazetteerModifiers)) {
  const key = phraseKey(name);
  if (!key) continue;
  const entry = entryFor(key, name);
  if (modifier.ambiguous) entry.ambiguous = true;
  if (modifier.wholeSegmentOnly) entry.wholeSegmentOnly = true;
  if (modifier.defaultCountry) entry.defaultCountry = modifier.defaultCountry;
  for (const code of modifier.alsoCountries ?? []) {
    if (isMarket(code)) {
      if (!entry.kinds.has(code)) entry.kinds.set(code, new Set(["city"]));
    } else entry.nonMarket.add(code);
  }
}
// A multi-token anchor phrase that contains an ordinary, unambiguous place of the
// same market ("Costa Mesa" ⊃ "Mesa", "Michigan City" ⊃ "Michigan") is an
// ordinary place itself: the phrase must not shadow what its part already proved.
for (const entry of entries.values()) {
  if (!entry.anchorOnlyIn.size || entry.tokenCount < 2) continue;
  const tokens = entry.key.split(" ");
  for (const country of [...entry.anchorOnlyIn]) {
    let contains = false;
    for (let length = entry.tokenCount - 1; length >= 1 && !contains; length--)
      for (let start = 0; start + length <= tokens.length && !contains; start++) {
        const part = entries.get(tokens.slice(start, start + length).join(" "));
        if (part && !part.ambiguous && part.kinds.size === 1 && part.kinds.has(country) && !part.anchorOnlyIn.has(country) && part.nonMarket.size === 0) contains = true;
      }
    if (contains) entry.anchorOnlyIn.delete(country);
  }
}
for (const entry of entries.values()) {
  const ordinary = entry.kinds.size - entry.anchorOnlyIn.size;
  if (ordinary + entry.nonMarket.size > 1) entry.ambiguous = true;
  entry.anchorOnly = entry.anchorOnlyIn.size > 0 && ordinary === 0 && entry.nonMarket.size === 0 && !entry.defaultCountry;
}
/** Japanese-script forms, longest first, for the ward/city suffix rule. */
const cjkKeys = [...entries.keys()].filter((key) => cjk.test(key) && !key.includes(" ")).sort((a, b) => b.length - a.length);

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
type ItemKind = "name" | "code" | "explicit";
interface Item {
  type: ItemKind;
  text: string;
  segment: number;
  /** Market countries this item could stand for. */
  candidates: Set<SupportedMarket>;
  /** Countries in which the name is a region (used when the item qualifies a preceding city). */
  regionReading: Set<SupportedMarket>;
  ambiguous: boolean;
  cityish: boolean;
  entry: Entry | null;
  code: CodeEntry | null;
  /** Guarded code: true once a known city or explicit country anchors it. */
  anchored: boolean;
  resolved: SupportedMarket | null;
  confidence: GazetteerConfidence | null;
  /** The item's location anchored two different countries. */
  inConflict: boolean;
  /** Anchor-only locality: can anchor a code, never resolves alone. */
  anchorOnly: boolean;
}

const hasKind = (entry: Entry, country: SupportedMarket, ...kinds: GazetteerKind[]): boolean => kinds.some((kind) => entry.kinds.get(country)?.has(kind));
const isCityOnly = (entry: Entry): boolean => [...entry.kinds.values()].every((kinds) => !kinds.has("region") && !kinds.has("region_code"));

function nameItem(entry: Entry, text: string, segment: number): Item {
  const candidates = new Set<SupportedMarket>(entry.kinds.keys());
  const regionReading = new Set<SupportedMarket>([...entry.kinds.keys()].filter((country) => hasKind(entry, country, "region")));
  const ordinary = new Set<SupportedMarket>([...candidates].filter((country) => !entry.anchorOnlyIn.has(country)));
  return { type: "name", text, segment, candidates, regionReading: regionReading.size ? regionReading : candidates, ambiguous: entry.ambiguous || (entry.anchorOnly ? candidates.size !== 1 : ordinary.size !== 1), cityish: isCityOnly(entry), entry, code: null, anchored: true, resolved: null, confidence: null, inConflict: false, anchorOnly: entry.anchorOnly };
}
function codeItem(code: CodeEntry, text: string, segment: number): Item {
  const candidates = new Set<SupportedMarket>(code.countries);
  if (code.collision) candidates.add(code.collision.country);
  return { type: "code", text, segment, candidates, regionReading: candidates, ambiguous: candidates.size !== 1, cityish: false, entry: null, code, anchored: !code.guarded, resolved: null, confidence: null, inConflict: false, anchorOnly: false };
}
function explicitItem(country: SupportedMarket, text: string, segment: number): Item {
  const candidates = new Set<SupportedMarket>([country]);
  return { type: "explicit", text, segment, candidates, regionReading: candidates, ambiguous: false, cityish: false, entry: null, code: null, anchored: true, resolved: country, confidence: "high", inConflict: false, anchorOnly: false };
}

/** Explicit country mentions inside a segment (whole segment, token n-grams, ISO-style short labels). */
function explicitCountryAt(tokens: Token[], index: number): { country: SupportedMarket; length: number } | null {
  for (let length = Math.min(4, tokens.length - index); length >= 1; length--) {
    const slice = tokens.slice(index, index + length).map((token) => token.text);
    const country = explicitCountryAlias(slice.join(" ")) ?? explicitCountryAlias(slice.join("-"));
    if (country) return { country, length };
  }
  // ISO-style labels only as a complete segment ("USA", "Remote - US" after
  // splitting) or beside one region code ("US-TX", "TX USA"), as in
  // country-evidence.ts — never inside prose such as "CAN WORK REMOTELY".
  const bare = tokens[index].text.normalize("NFKC").replace(/\./g, "");
  const others = tokens.filter((_, position) => position !== index);
  const besideCode = tokens.length <= 2 && others.every((token) => /^[A-Z]{2,3}$/.test(token.text.normalize("NFKC")) && codes.has(token.text.normalize("NFKC")));
  if (/^[A-Z]{2,3}$/.test(bare) && shortLabels[bare] && besideCode) return { country: shortLabels[bare], length: 1 };
  return null;
}

function itemsForSegment(segment: string, segmentIndex: number): Item[] {
  const items: Item[] = [];
  const tokens = tokenize(segment);
  let index = 0;
  while (index < tokens.length) {
    const explicit = explicitCountryAt(tokens, index);
    if (explicit) {
      items.push(explicitItem(explicit.country, segment.slice(tokens[index].start, tokens[index + explicit.length - 1].end), segmentIndex));
      index += explicit.length;
      continue;
    }
    let matched: { entry: Entry; length: number; text: string } | null = null;
    for (let length = Math.min(maxTokens, tokens.length - index); length >= 1 && !matched; length--) {
      const key = tokens.slice(index, index + length).map((token) => token.norm).join(" ");
      const entry = entries.get(key);
      if (entry && (!entry.wholeSegmentOnly || length === tokens.length)) matched = { entry, length, text: segment.slice(tokens[index].start, tokens[index + length - 1].end) };
    }
    if (!matched && cjk.test(tokens[index].norm)) {
      const norm = tokens[index].norm;
      for (const key of cjkKeys) {
        if (norm.length > key.length && norm.startsWith(key) && cjkSuffix.test(norm.slice(key.length))) {
          const entry = entries.get(key);
          if (entry && !entry.wholeSegmentOnly) { matched = { entry, length: 1, text: tokens[index].text.slice(0, key.length) }; break; }
        }
      }
    }
    if (matched) {
      items.push(nameItem(matched.entry, matched.text, segmentIndex));
      index += matched.length;
      continue;
    }
    // "D.C." / "B.C." are written with periods; the code table is period-free.
    const upper = tokens[index].text.normalize("NFKC").replace(/\./g, "");
    const code = /^[A-Z]{2,3}$/.test(upper) ? codes.get(upper) : undefined;
    if (code) {
      const item = codeItem(code, tokens[index].text, segmentIndex);
      // "US-TX" / "USA TX": an explicit country immediately before the code anchors it.
      const before = items[items.length - 1];
      if (code.guarded && before?.type === "explicit" && before.segment === segmentIndex && code.countries.has(before.resolved as SupportedMarket)) {
        item.anchored = true;
        item.candidates = new Set([before.resolved as SupportedMarket]);
        item.ambiguous = false;
      }
      items.push(item);
    }
    index++;
  }
  return items;
}

/** Guarded and ambiguous codes take the reading supported by the city or explicit country next to them. */
function anchorCodes(group: Item[], unitItems: Item[]): void {
  for (let index = 0; index < group.length; index++) {
    const item = group[index];
    if (item.type !== "code" || item.resolved) continue;
    const previous = group[index - 1];
    const cityBefore = previous && previous.type === "name" && previous.cityish && previous.segment >= item.segment - 1 ? previous : null;
    const adjacentExplicit = unitItems.find((other) => other.type === "explicit" && Math.abs(other.segment - item.segment) <= 1);
    let supported: SupportedMarket[] = [];
    if (cityBefore) supported = [...item.candidates].filter((country) => cityBefore.candidates.has(country));
    else if (adjacentExplicit) supported = [...item.candidates].filter((country) => adjacentExplicit.candidates.has(country));
    if (supported.length === 1) {
      item.anchored = true;
      item.candidates = new Set(supported);
      item.ambiguous = false;
    } else if (supported.length > 1) {
      item.candidates = new Set(supported);
    }
  }
}

/** A name with an ordinary reading plus anchor-only readings ("Glasgow": GB, anchor US)
 * follows a code or explicit country of an anchor market beside it ("Glasgow, DE",
 * "Glasgow, KY" → US) and otherwise keeps its ordinary reading ("Glasgow" → GB). */
function settleAnchorReadings(group: Item[]): void {
  for (const item of group) {
    if (item.type !== "name" || !item.entry || !item.entry.anchorOnlyIn.size || item.entry.anchorOnly) continue;
    const anchorMarkets = item.entry.anchorOnlyIn;
    const beside = group.find((other) => other !== item && (other.type === "explicit" || (other.type === "code" && other.anchored)) && other.candidates.size === 1 && anchorMarkets.has([...other.candidates][0]));
    if (beside) item.candidates = new Set(beside.candidates);
    else item.candidates = new Set([...item.candidates].filter((country) => !anchorMarkets.has(country)));
  }
}
function resolveGroup(group: Item[], unitItems: Item[]): boolean {
  anchorCodes(group, unitItems);
  settleAnchorReadings(group);
  const anchors = group.filter((item) => !item.ambiguous && item.anchored && !item.anchorOnly);
  const anchorCountries = new Set<SupportedMarket>(anchors.map((item) => [...item.candidates][0]));
  const conflict = anchorCountries.size > 1;
  for (const item of anchors) {
    item.resolved = [...item.candidates][0];
    item.confidence = "high";
    item.inConflict = conflict;
  }
  if (!conflict) {
    const open = group.filter((item) => item.ambiguous || !item.anchored || item.anchorOnly);
    if (anchorCountries.size === 1) {
      const country = [...anchorCountries][0];
      for (const item of open) {
        if (item.type === "code" && !item.anchored) continue; // guarded code with no city or country next to it
        if (item.candidates.has(country)) { item.resolved = country; item.confidence = "high"; }
      }
    } else {
      // No anchor: mutually disambiguating names ("London, Ontario", "Perth, WA", "Melbourne, Victoria").
      const mutual = open.filter((item) => (!item.anchorOnly || item.candidates.size === 1) && (item.type !== "code" || item.anchored || item.ambiguous));
      if (mutual.length >= 2) {
        const first = mutual[0];
        let intersection = new Set<SupportedMarket>(first.candidates);
        for (const item of mutual.slice(1)) {
          const reading = item.segment > first.segment && item.type === "name" ? item.regionReading : item.candidates;
          intersection = new Set([...intersection].filter((country) => reading.has(country)));
        }
        if (intersection.size === 1) {
          const country = [...intersection][0];
          for (const item of mutual) { item.resolved = country; item.confidence = "high"; }
        }
      }
    }
  }
  // A lone unambiguous city is medium; a city qualified by a region, code or country of the same country is high.
  for (const item of group) {
    if (item.type !== "name" || !item.cityish || !item.resolved) continue;
    const qualified = group.some((other) => other !== item && other.resolved === item.resolved && (other.type !== "name" || !other.cityish));
    item.confidence = qualified ? "high" : "medium";
  }
  return conflict;
}

function kindOf(item: Item): GazetteerKind {
  if (item.type === "code") return "region_code";
  const entry = item.entry as Entry;
  const kinds = entry.kinds.get(item.resolved as SupportedMarket);
  if (kinds?.has("region")) return "region";
  if (kinds?.has("metro") && !kinds.has("city")) return "metro";
  return "city";
}

export function gazetteerCountryEvidence(label: string): GazetteerCountryEvidence {
  const result: GazetteerCountryEvidence = { countries: [], matches: [], ambiguous: [], conflict: false };
  if (typeof label !== "string" || !label.trim()) return result;
  const allItems: Item[] = [];
  let segmentIndex = 0;
  for (const unit of label.normalize("NFKC").split(unitSeparator)) {
    const unitItems: Item[] = [];
    const groups: Item[][] = [];
    const shape: { segment: string; items: Item[] }[] = [];
    for (const raw of unit.split(segmentSeparator)) {
      const segment = raw.trim();
      segmentIndex++;
      if (!segment || negative.test(segment)) continue;
      const items = itemsForSegment(segment, segmentIndex);
      shape.push({ segment, items });
      if (!items.length) continue;
      const startsGroup = items.some((item) => item.type === "name" && item.cityish) || !groups.length;
      if (startsGroup) groups.push([]);
      groups[groups.length - 1].push(...items);
      unitItems.push(...items);
    }
    for (const group of groups) if (resolveGroup(group, unitItems)) result.conflict = true;
    // "<unknown place>, <CODE>": exactly two segments, the first names no known
    // place (letters only, no remote/hybrid words), the second is one shape-safe
    // word-like code still unanchored. Medium confidence: the code is read as
    // the region because nothing else in the location could be meant by it.
    if (shape.length === 2 && shape[0].items.length === 0 && shape[1].items.length === 1) {
      const [place, code] = [shape[0], shape[1].items[0]];
      if (code.type === "code" && code.code?.shapeSafe && !code.anchored && !code.resolved && placeLike.test(place.segment) && code.text.normalize("NFKC") === shape[1].segment.normalize("NFKC")) {
        code.anchored = true;
        code.resolved = [...code.candidates][0];
        code.confidence = "medium";
      }
    }
    allItems.push(...unitItems);
  }
  // London rule: default only when nothing anywhere in the label points at a competing candidate.
  for (const item of allItems) {
    if (item.resolved || item.type !== "name" || !item.entry?.defaultCountry) continue;
    const fallback = item.entry.defaultCountry;
    const competing = [...item.candidates].filter((country) => country !== fallback);
    const contested = allItems.some((other) => other !== item && competing.some((country) => other.candidates.has(country)));
    if (!contested) { item.resolved = fallback; item.confidence = "medium"; }
  }
  const seenAmbiguous = new Set<string>();
  for (const item of allItems) {
    if (item.type === "explicit") {
      // Explicit labels are country-evidence.ts's job; they surface here only to report every side of a conflict.
      if (item.inConflict && item.resolved && !result.countries.includes(item.resolved)) result.countries.push(item.resolved);
      continue;
    }
    if (item.resolved && item.confidence) {
      if (item.code?.collision && item.resolved === item.code.collision.country) continue; // "Toronto, CA": the code was the country label
      result.matches.push({ token: item.text, country: item.resolved, kind: kindOf(item), confidence: item.confidence });
      if (!result.countries.includes(item.resolved)) result.countries.push(item.resolved);
    } else if (item.ambiguous && !item.anchorOnly && (item.type === "name" || !item.code?.wordGuarded || item.code.collision)) {
      const key = normalizeToken(item.text);
      if (!seenAmbiguous.has(key)) { seenAmbiguous.add(key); result.ambiguous.push(item.text); }
    }
  }
  return result;
}

/** Explicit country labels win outright; the gazetteer fills in only when it is not in conflict with itself. */
export function combineCountryEvidence(explicit: string[], gazetteer: ReturnType<typeof gazetteerCountryEvidence>): string[] {
  const stated = [...new Set(explicit.filter((code) => typeof code === "string" && code))];
  if (stated.length) return stated;
  return gazetteer.conflict ? [] : [...gazetteer.countries];
}
