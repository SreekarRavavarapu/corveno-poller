export const supportedMarketCodes = ["US", "CA", "AU", "GB", "IN", "SG", "JP"] as const;
export type SupportedMarket = typeof supportedMarketCodes[number];
const normalized = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
const aliases = new Map<string, SupportedMarket>();
// Country names come from the runtime's CLDR-backed display names. This maps
// explicit country labels, never a city, language or inferred nationality.
for (const locale of ["en", "fr", "ja", "hi", "ta", "zh", "ms"]) {
  const display = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
  for (const code of supportedMarketCodes) {
    const name = display.of(code);
    if (name) aliases.set(normalized(name), code);
  }
}
for (const [name, code] of [["United States of America", "US"], ["Great Britain", "GB"], ["日本国", "JP"]] as const) aliases.set(normalized(name), code);
export function explicitCountryAlias(value: unknown): SupportedMarket | null {
  return typeof value === "string" ? aliases.get(normalized(value)) ?? null : null;
}
const shortLabels: Record<string, SupportedMarket> = { US:"US", USA:"US", "U.S.":"US", "U.S.A.":"US", UK:"GB", "U.K.":"GB", GB:"GB", GBR:"GB", AU:"AU", AUS:"AU", CAN:"CA", SG:"SG", SGP:"SG", JP:"JP", JPN:"JP" };
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = [...aliases.entries()].map(([name,country]) => ({ country, pattern:new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escape(name)}(?![\\p{L}\\p{M}\\p{N}])`,"giu"), name }));
const negative = /\b(?:not|except|excluding|excluded|outside|sauf|hors|exclu(?:e|s|es)?)\b|以外|除外|対象外|除く|不包括|不含|बाहर/iu;
const beforeNegative = /(?:\bnot(?:\s+(?:in|within|from|available\s+in))?|\bexcept|\bexcluding|\boutside(?:\s+of)?|\bsauf|\bhors(?:\s+(?:de|du|des))?)\s+(?:the\s+)?$/iu;
const afterNegative = /^\s*(?:is\s+|are\s+)?(?:excluded|not\s+(?:included|eligible|available)|exclu(?:e|s|es)?|以外|除外|対象外|を?除く|के\s+बाहर)/iu;
export interface LocationCountryEvidence { countries: SupportedMarket[]; excludedCountries: SupportedMarket[]; evidence: {country:SupportedMarket;quote:string;polarity:"positive"|"excluded"}[]; }
/** Conservative country evidence from locality labels. ISO abbreviations are
 * accepted only as complete location segments or Remote-US-style labels, so
 * ordinary prose such as "work with us" cannot establish a US location. */
export function locationCountryEvidence(locations: string[]): LocationCountryEvidence {
  const positive = new Set<SupportedMarket>(), excluded = new Set<SupportedMarket>();
  const evidence: LocationCountryEvidence["evidence"] = [];
  for (const raw of locations) {
    for (const segment of raw.normalize("NFKC").split(/[;,/|()（）]+/u).map(value=>value.trim()).filter(Boolean)) {
      const hasNegative = negative.test(segment);
      for (const {country,pattern} of names) {
        for (const match of segment.matchAll(pattern)) {
          const start=match.index??0;
          const denied=beforeNegative.test(segment.slice(0,start))||afterNegative.test(segment.slice(start+match[0].length));
          if(denied){excluded.add(country);evidence.push({country,quote:raw,polarity:"excluded"});}
          else if(!hasNegative){positive.add(country);evidence.push({country,quote:raw,polarity:"positive"});}
        }
      }
      // Complete native exclusion forms need no inferred translation of prose.
      for(const [name,country] of aliases){
        const n=normalized(segment);
        if(n===`${name}以外`||n===`${name}除外`||n===`${name}を除く`||n===`不包括${name}`||n===`不含${name}`){excluded.add(country);evidence.push({country,quote:raw,polarity:"excluded"});}
      }
      for(const [label,country] of Object.entries(shortLabels)) {
        const literal=new RegExp(`^(?:${escape(label)}|remote\\s*[-–—:/]\\s*${escape(label)}|${escape(label)}\\s*[-–—:/]\\s*remote)$`,"u");
        const remoteCaseInsensitive=new RegExp(`^remote\\s*[-–—:/]\\s*${escape(label)}$`,"iu");
        if(!hasNegative&&(literal.test(segment)||remoteCaseInsensitive.test(segment))){positive.add(country);evidence.push({country,quote:raw,polarity:"positive"});}
        const mention=new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escape(label)}(?![\\p{L}\\p{M}\\p{N}])`,"gu");
        for(const match of segment.matchAll(mention)){const start=match.index??0;if(beforeNegative.test(segment.slice(0,start))||afterNegative.test(segment.slice(start+match[0].length))){excluded.add(country);evidence.push({country,quote:raw,polarity:"excluded"});}}
      }
    }
  }
  return {countries:[...positive].filter(country=>!excluded.has(country)),excludedCountries:[...excluded],evidence};
}
