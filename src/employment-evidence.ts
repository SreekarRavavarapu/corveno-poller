/**
 * Deterministic employment-type evidence from a posting's structured field,
 * title and full description. Conservative by design: it only reports a type
 * when the source states one; nothing is inferred from role seniority,
 * company, location or classification hints. Every reported type carries the
 * exact quote so reviewers and the matcher can show why.
 *
 * The result feeds `corpus_listings.structured_job_type` for sources without
 * a structured field (Greenhouse) and lets the matcher resolve rows that would
 * otherwise stay "verification pending". Unknown stays unknown.
 *
 * Bundle-friendly: relative imports only (this file is shipped inside the
 * separate collector bundle).
 */
export type EmploymentType =
  | "internship"
  | "full_time"
  | "part_time"
  | "contract"
  | "research"
  | "co_op"
  | "temporary"
  | "apprenticeship";

export type EmploymentEvidenceField = "structured" | "title" | "description" | "implied";
export type EmploymentConfidence = "high" | "medium";

export interface EmploymentEvidenceItem {
  type: EmploymentType;
  quote: string;
  field: EmploymentEvidenceField;
  confidence: EmploymentConfidence;
}

export interface EmploymentTypeEvidence {
  /** Resolved type, or null when the source states nothing usable. */
  type: EmploymentType | null;
  confidence: EmploymentConfidence | null;
  /** True when high-confidence statements contradict each other (e.g. both
   * "Part-time" and "Full-time" as typed statements). `type` is null then. */
  conflict: boolean;
  items: EmploymentEvidenceItem[];
}

export const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  "internship",
  "full_time",
  "part_time",
  "contract",
  "research",
  "co_op",
  "temporary",
  "apprenticeship",
];

const INTERNSHIP_FAMILY: readonly EmploymentType[] = ["internship", "co_op", "apprenticeship"];
const MAX_QUOTE = 160;

/** Map a free-text value (from "Employment type: X") to an enum type. */
export function employmentTypeFromLabel(raw: string): { type: EmploymentType; confidence: EmploymentConfidence } | null {
  const value = raw.normalize("NFKC").toLowerCase().replace(/[\s_/-]+/g, " ").trim();
  if (!value) return null;
  const exact: Record<string, { type: EmploymentType; confidence: EmploymentConfidence }> = {
    "full time": { type: "full_time", confidence: "high" },
    fulltime: { type: "full_time", confidence: "high" },
    "full time employee": { type: "full_time", confidence: "high" },
    "full time permanent": { type: "full_time", confidence: "high" },
    "permanent full time": { type: "full_time", confidence: "high" },
    permanent: { type: "full_time", confidence: "medium" },
    regular: { type: "full_time", confidence: "medium" },
    "regular full time": { type: "full_time", confidence: "high" },
    "part time": { type: "part_time", confidence: "high" },
    parttime: { type: "part_time", confidence: "high" },
    "part time permanent": { type: "part_time", confidence: "high" },
    "permanent part time": { type: "part_time", confidence: "high" },
    intern: { type: "internship", confidence: "high" },
    internship: { type: "internship", confidence: "high" },
    "internship full time": { type: "internship", confidence: "high" },
    "full time internship": { type: "internship", confidence: "high" },
    "co op": { type: "co_op", confidence: "high" },
    coop: { type: "co_op", confidence: "high" },
    contract: { type: "contract", confidence: "high" },
    contractor: { type: "contract", confidence: "high" },
    contractual: { type: "contract", confidence: "high" },
    "fixed term": { type: "contract", confidence: "high" },
    "fixed term contract": { type: "contract", confidence: "high" },
    "full time contract": { type: "contract", confidence: "high" },
    "contract full time": { type: "contract", confidence: "high" },
    freelance: { type: "contract", confidence: "high" },
    "contract to hire": { type: "contract", confidence: "high" },
    temporary: { type: "temporary", confidence: "high" },
    temp: { type: "temporary", confidence: "high" },
    seasonal: { type: "temporary", confidence: "high" },
    casual: { type: "temporary", confidence: "medium" },
    "temporary full time": { type: "temporary", confidence: "high" },
    apprenticeship: { type: "apprenticeship", confidence: "high" },
    apprentice: { type: "apprenticeship", confidence: "high" },
    research: { type: "research", confidence: "medium" },
  };
  if (exact[value]) return exact[value];
  // Compound labels such as "Full-time, Regular" or "Contract (12 months)".
  const head = value.replace(/\(.*?\)/g, " ").split(/[,;|]/)[0]!.trim();
  if (head && exact[head]) return exact[head];
  return null;
}

const quoteOf = (text: string, index: number, length: number) => {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 60);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE);
};

/** Study/education mentions never establish an employment type. */
const STUDY_CONTEXT = /\b(?:student|students|study|studies|studying|enrol+ed|enrolment|enrollment|degree|programme|program|course|education|university|college|school)\b/i;

function titleItems(rawTitle: string): EmploymentEvidenceItem[] {
  const title = rawTitle.normalize("NFKC");
  const items: EmploymentEvidenceItem[] = [];
  const push = (type: EmploymentType, match: RegExpMatchArray | null, confidence: EmploymentConfidence) => {
    if (match && match.index !== undefined) items.push({ type, quote: quoteOf(title, match.index, match[0].length), field: "title", confidence });
  };
  // Internship-program administration is not an internship.
  const administrative = /\b(?:intern(?:ship)?s?|co[- ]?ops?)\s+(?:program(?:me)?\s+(?:manager|coordinator|director|lead)|recruit(?:er|ing|ment)|hiring|talent|coordinator|manager)\b/i;
  const stripped = title.replace(administrative, " ");
  push("internship", stripped.match(/\bintern(?:ship)?s?\b/i), "high");
  push("internship", stripped.match(/\bworking student\b/i), "medium");
  push("internship", stripped.match(/インターン(?:シップ)?/), "high");
  push("co_op", stripped.match(/\bco[- ]?op\b/i), "high");
  push("apprenticeship", stripped.match(/\bapprentice(?:ship)?s?\b/i), "high");
  push("apprenticeship", stripped.match(/\b(?:alternance|apprenti(?:e|s)?)\b/i), "high");
  push("part_time", title.match(/\bpart[- ]time\b/i), "high");
  push("part_time", title.match(/\btemps partiel\b/i), "high");
  push("part_time", title.match(/(?:パート(?:タイム)?|アルバイト)/), "high");
  push("contract", title.match(/\b(?:contractor|contractual|fixed[- ]term|freelance|FTC)\b/i), "high");
  push("contract", title.match(/\bcontract\b/i), "medium");
  push("contract", title.match(/\bCDD\b/), "high");
  push("contract", title.match(/(?:契約社員|業務委託)/), "high");
  push("temporary", title.match(/\b(?:temporary|temp|seasonal)\b/i), "high");
  push("temporary", title.match(/\bcasual\b/i), "medium");
  push("temporary", title.match(/(?:派遣|臨時)/), "high");
  push("full_time", title.match(/\bfull[- ]time\b/i), "medium");
  push("full_time", title.match(/\btemps plein\b/i), "high");
  push("full_time", title.match(/正社員/), "high");
  push("full_time", title.match(/\bCDI\b/), "medium");
  push("research", title.match(/\b(?:postdoc(?:toral)?|post-doctoral|research fellow)\b/i), "medium");
  return items;
}

function descriptionItems(rawDescription: string): EmploymentEvidenceItem[] {
  const text = rawDescription.normalize("NFKC");
  const items: EmploymentEvidenceItem[] = [];
  const push = (type: EmploymentType, index: number, length: number, confidence: EmploymentConfidence) => {
    items.push({ type, quote: quoteOf(text, index, length), field: "description", confidence });
  };
  // "Employment type: Full-time", "Job Type: Contract", "Time Type: Part time",
  // "Position type: Internship", "Worker type: Regular", "Schedule: Full-time".
  const typed = /\b(?:employment|job|position|contract|worker|work|time|role|engagement|hours)\s*(?:type|category|status)?\s*[:\-–|]\s*([A-Za-z][A-Za-z0-9 /,()-]{1,40})/gi;
  for (const match of text.matchAll(typed)) {
    if (!/type|category|status|hours|schedule/i.test(match[0].split(/[:\-–|]/)[0]!) && !/\bhours\b/i.test(match[0])) continue;
    const label = employmentTypeFromLabel(match[1]!);
    if (label && match.index !== undefined) push(label.type, match.index, match[0].length, label.confidence);
  }
  const schedule = /\bschedule\s*[:\-–|]\s*(full[- ]?time|part[- ]?time)\b/gi;
  for (const match of text.matchAll(schedule)) {
    const label = employmentTypeFromLabel(match[1]!);
    if (label && match.index !== undefined) push(label.type, match.index, match[0].length, "high");
  }
  // "This is a full-time position", "This role is a 6-month contract".
  const sentence = /\bthis (?:is (?:a|an)|(?:position|role|job|opportunity) is (?:a|an))\s+(?:[\w-]+\s+){0,3}?(full[- ]time|part[- ]time|contract|temporary|fixed[- ]term|internship|co[- ]?op|apprenticeship|seasonal|freelance)\b/gi;
  for (const match of text.matchAll(sentence)) {
    const label = employmentTypeFromLabel(match[1]!);
    if (!label || match.index === undefined) continue;
    const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 30);
    if (STUDY_CONTEXT.test(tail)) continue;
    // "full-time contract position" / "full-time internship": the commitment
    // word that follows the hours word is the stronger statement.
    const commitment = tail.match(/^\s+(contract(?:or)?|fixed[- ]term|temporary|temp|seasonal|internship|intern|co[- ]?op|apprenticeship)\b/i);
    const type = commitment ? employmentTypeFromLabel(commitment[1]!)?.type ?? label.type : label.type;
    push(type, match.index, match[0].length + (commitment ? commitment[0].length : 0), "high");
  }
  // "full-time position/role/opportunity/employment/hours" (medium): common in
  // Greenhouse and Lever prose that has no typed field.
  const prose = /\b(full[- ]time|part[- ]time|temporary|seasonal|fixed[- ]term)\s+(?:position|role|opportunity|employment|job|hours|basis|contract)\b/gi;
  for (const match of text.matchAll(prose)) {
    if (match.index === undefined) continue;
    const before = text.slice(Math.max(0, match.index - 25), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 25);
    if (STUDY_CONTEXT.test(before) || STUDY_CONTEXT.test(after)) continue;
    const label = employmentTypeFromLabel(match[1]!);
    if (!label) continue;
    const isContract = /\bcontract\b/i.test(match[0]) && label.type !== "contract";
    push(isContract ? "contract" : label.type, match.index, match[0].length, "medium");
  }
  // Japanese typed statements: 雇用形態：正社員 / 契約社員 / アルバイト / 派遣.
  const ja = /雇用形態\s*[:：]?\s*(正社員|契約社員|パート(?:タイム)?|アルバイト|派遣(?:社員)?|業務委託|インターン(?:シップ)?|嘱託)/g;
  for (const match of text.matchAll(ja)) {
    if (match.index === undefined) continue;
    const map: Record<string, EmploymentType> = { 正社員: "full_time", 契約社員: "contract", パート: "part_time", パートタイム: "part_time", アルバイト: "part_time", 派遣: "temporary", 派遣社員: "temporary", 業務委託: "contract", インターン: "internship", インターンシップ: "internship", 嘱託: "contract" };
    const type = map[match[1]!];
    if (type) push(type, match.index, match[0].length, "high");
  }
  // French typed statements: "Type de contrat : CDI / CDD / Stage / Alternance", "Temps plein".
  const fr = /\btype\s+(?:de\s+)?(?:contrat|poste|d'emploi|emploi)\s*[:\-–]\s*([A-Za-zÀ-ÿ' -]{2,30})/gi;
  for (const match of text.matchAll(fr)) {
    if (match.index === undefined) continue;
    const v = match[1]!.normalize("NFKC").toLowerCase().trim();
    const type: EmploymentType | null = /^cdi\b/.test(v) ? "full_time" : /^cdd\b|^contrat/.test(v) ? "contract" : /^stage\b|^stagiaire/.test(v) ? "internship" : /^alternance|^apprenti/.test(v) ? "apprenticeship" : /^temps partiel/.test(v) ? "part_time" : /^temps plein/.test(v) ? "full_time" : /^int[ée]rim|^temporaire|^saisonnier/.test(v) ? "temporary" : null;
    if (type) push(type, match.index, match[0].length, /^cdi\b/.test(v) ? "medium" : "high");
  }
  return items;
}

const rank: Record<EmploymentType, number> = {
  internship: 8,
  co_op: 8,
  apprenticeship: 8,
  research: 5,
  contract: 4,
  temporary: 4,
  part_time: 3,
  full_time: 1,
};

/**
 * Resolve a single type from evidence. Internship-family evidence wins over
 * hours/commitment types (an internship stays an internship even when its
 * hours are full-time). Otherwise commitment types (contract/temporary) win
 * over part-time, which wins over full-time; a genuine part-time versus
 * full-time contradiction at high confidence is reported as a conflict.
 */
export function resolveEmploymentType(items: EmploymentEvidenceItem[]): Pick<EmploymentTypeEvidence, "type" | "confidence" | "conflict"> {
  if (!items.length) return { type: null, confidence: null, conflict: false };
  const family = items.filter((item) => INTERNSHIP_FAMILY.includes(item.type));
  if (family.length) {
    const best = [...family].sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1))[0]!;
    return { type: best.type, confidence: best.confidence, conflict: false };
  }
  const high = items.filter((item) => item.confidence === "high");
  const pool = high.length ? high : items;
  const types = [...new Set(pool.map((item) => item.type))];
  if (high.length && types.includes("full_time") && types.includes("part_time"))
    return { type: null, confidence: null, conflict: true };
  const winner = types.sort((a, b) => rank[b] - rank[a])[0]!;
  return { type: winner, confidence: high.length ? "high" : "medium", conflict: false };
}

/** Any commitment marker in title or text. When NONE is present in a complete
 * description the posting is treated as full-time with the reason recorded
 * (owner decision, Sep 15, 2026: "commitment not stated"). */
const COMMITMENT_MARKERS = /\b(?:part[- ]?time|full[- ]?time|contract(?:or|ual)?|fixed[- ]term|temporary|temp\b|seasonal|casual|freelance|hourly|per diem|prn|locum|zero[- ]hours?|intern(?:ship)?s?|co[- ]?op|apprentice(?:ship)?s?|working student|fellowship|volunteer|stage|stagiaire|alternance|cdd|cdi|temps (?:plein|partiel)|int[ée]rim|vacation)\b|正社員|契約社員|派遣|アルバイト|パート|インターン|業務委託|嘱託|臨時|フリーランス/i;

export function impliedFullTime(input: { title: string; description: string; kind?: string | null }): EmploymentEvidenceItem | null {
  if (input.kind === "intern") return null;
  const text = `${input.title}\n${input.description}`.normalize("NFKC");
  if (input.description.trim().length < 200) return null;
  if (COMMITMENT_MARKERS.test(text)) return null;
  return { type: "full_time", quote: "Commitment not stated: the posting mentions no part-time, contract, temporary, seasonal, internship or apprenticeship terms.", field: "implied", confidence: "medium" };
}

export function employmentTypeEvidence(input: { title: string; description?: string | null; structured?: string | null; kind?: string | null }): EmploymentTypeEvidence {
  const items: EmploymentEvidenceItem[] = [];
  if (input.structured && (EMPLOYMENT_TYPES as readonly string[]).includes(input.structured))
    items.push({ type: input.structured as EmploymentType, quote: input.structured, field: "structured", confidence: "high" });
  items.push(...titleItems(input.title ?? ""));
  if (input.description) items.push(...descriptionItems(input.description));
  if (!items.length && input.description) {
    const implied = impliedFullTime({ title: input.title ?? "", description: input.description, kind: input.kind ?? null });
    if (implied) items.push(implied);
  }
  const resolved = resolveEmploymentType(items);
  // A structured commitment type is authoritative among commitment types, but
  // internship-family title evidence still classifies the role as an internship.
  if (input.structured && resolved.type && !INTERNSHIP_FAMILY.includes(resolved.type) && (EMPLOYMENT_TYPES as readonly string[]).includes(input.structured))
    return { type: input.structured as EmploymentType, confidence: "high", conflict: false, items };
  return { ...resolved, items };
}
