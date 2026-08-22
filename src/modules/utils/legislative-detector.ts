import { normalizeForSearch } from "./text-normalizer";

export type Jurisdiction = "RO" | "EU" | "EN" | "FR" | "DE" | "INT";

export interface LegislativeMatch {
  jurisdiction: Jurisdiction;
  type: "statute" | "bill";
  matchedPattern: string;
  subType: string;
}

export interface LegislativeFields {
  itemType: "statute" | "bill";
  title: string;
  codeNumber: string;
  code: string;
  dateEnacted: string;
  authority: string;
  jurisdiction: string;
}

// ─── Pattern definitions ─────────────────────────────────────────────

interface PatternDef {
  jurisdiction: Jurisdiction;
  type: "statute" | "bill";
  subType: string;
  // Test against normalized (lowercase, no diacritics) text
  regex: RegExp;
  // Optional: also test against original text (for case-sensitive patterns)
  originalRegex?: RegExp;
}

// EU patterns — must be checked BEFORE DE to avoid false matches
const EU_PATTERNS: PatternDef[] = [
  // Regulation (EU)/(EC)/(EEC) — including Implementing/Delegated/Commission/Council prefixes
  {
    jurisdiction: "EU", type: "statute", subType: "regulation",
    regex: /(?:implementing |delegated |commission |council )*regulation \((?:eu|ec|eec)\)/,
  },
  // French EU
  {
    jurisdiction: "EU", type: "statute", subType: "regulation",
    regex: /reglement \(ue\)/,
  },
  // German EU — Verordnung (EU)/(EC)
  {
    jurisdiction: "EU", type: "statute", subType: "regulation",
    regex: /verordnung \((?:eu|eg|ec)\)/,
  },
  // Directive (EU)/(EC)
  {
    jurisdiction: "EU", type: "statute", subType: "directive",
    regex: /directive \((?:eu|ec)\)/,
  },
  // Directive YYYY/ (e.g., Directive 2006/123/EC)
  {
    jurisdiction: "EU", type: "statute", subType: "directive",
    regex: /directive \d{4}\//,
  },
  // German EU Richtlinie (EU)/(EG)
  {
    jurisdiction: "EU", type: "statute", subType: "directive",
    regex: /richtlinie \((?:eu|eg)\)/,
  },
  // Framework Decision
  {
    jurisdiction: "EU", type: "statute", subType: "decision",
    regex: /framework decision/,
  },
  // Decision (EU)/(EC)
  {
    jurisdiction: "EU", type: "statute", subType: "decision",
    regex: /decision \((?:eu|ec)\)/,
  },
];

// RO patterns
const RO_PATTERNS: PatternDef[] = [
  // Ordonanța de urgență / OUG / O.U.G.
  {
    jurisdiction: "RO", type: "statute", subType: "oug",
    regex: /(?:ordonanta de urgenta|oug|o\.u\.g\.) nr\./,
  },
  // Ordonanța Guvernului / OG / O.G.
  {
    jurisdiction: "RO", type: "statute", subType: "og",
    regex: /(?:ordonanta guvernului|og|o\.g\.) nr\./,
  },
  // Hotărârea Guvernului / HG / H.G.
  {
    jurisdiction: "RO", type: "statute", subType: "hg",
    regex: /(?:hotararea guvernului|hg|h\.g\.) nr\./,
  },
  // Decret-lege nr. (must come before Decret nr.)
  {
    jurisdiction: "RO", type: "statute", subType: "decret-lege",
    regex: /decret-lege nr\./,
  },
  // Decret nr.
  {
    jurisdiction: "RO", type: "statute", subType: "decret",
    regex: /decret nr\./,
  },
  // Legea/Lege/L. nr.
  {
    jurisdiction: "RO", type: "statute", subType: "lege",
    regex: /(?:legea|lege|l\.) nr\./,
  },
  // Ordinul ministrului / Ordin nr.
  {
    jurisdiction: "RO", type: "statute", subType: "ordin",
    regex: /(?:ordinul ministrului|ordin nr\.)/,
  },
  // Decizia CCR / Decizia Curții Constituționale / Decizia ÎCCJ
  {
    jurisdiction: "RO", type: "statute", subType: "decizie",
    regex: /decizia (?:ccr|curtii constitutionale|iccj)/,
  },
  // Codul + specific names
  {
    jurisdiction: "RO", type: "statute", subType: "cod",
    regex: /codul (?:civil|penal|fiscal|muncii|administrativ|silvic|aerian|de procedura)/,
  },
  // Constituția / Constitutia
  {
    jurisdiction: "RO", type: "statute", subType: "constitutie",
    regex: /constitutia(?:\s|$)/,
  },
  // Normă metodologică / Norme metodologice
  {
    jurisdiction: "RO", type: "statute", subType: "norma",
    regex: /norm[ae] metodologic[ae]/,
  },
  // Instrucțiune nr.
  {
    jurisdiction: "RO", type: "statute", subType: "instructiune",
    regex: /instructiune nr\./,
  },
  // Metodologie
  {
    jurisdiction: "RO", type: "statute", subType: "metodologie",
    regex: /^metodologie /,
  },
  // Dispoziție
  {
    jurisdiction: "RO", type: "statute", subType: "dispozitie",
    regex: /dispozitie nr\./,
  },
];

// FR patterns
// Note: normalizeForSearch strips ° (degree/superscript), so "n°" becomes "n " in normalized text
const FR_PATTERNS: PatternDef[] = [
  {
    jurisdiction: "FR", type: "statute", subType: "loi",
    regex: /loi n[° ]?\d/,
  },
  {
    jurisdiction: "FR", type: "statute", subType: "decret",
    regex: /decret n[° ]?\d/,
  },
  {
    jurisdiction: "FR", type: "statute", subType: "arrete",
    regex: /arrete (?:du|ministeriel)/,
  },
  {
    jurisdiction: "FR", type: "statute", subType: "ordonnance",
    regex: /ordonnance n[° ]?\d/,
  },
  {
    jurisdiction: "FR", type: "statute", subType: "circulaire",
    regex: /circulaire du/,
  },
  // French codes
  {
    jurisdiction: "FR", type: "statute", subType: "code",
    regex: /code (?:civil|penal|du travail|de commerce|de la sante|de l'environnement|de l'education)/,
  },
];

// EN patterns — case-sensitive for Act to avoid false positives
const EN_PATTERNS: PatternDef[] = [
  // Public Law / Pub. L. / P.L.
  {
    jurisdiction: "EN", type: "statute", subType: "public_law",
    regex: /(?:public law|pub\. l\.|p\.l\.) \d/,
  },
  // Executive Order
  {
    jurisdiction: "EN", type: "statute", subType: "executive_order",
    regex: /executive order \d/,
  },
  // Statutory Instrument
  {
    jurisdiction: "EN", type: "statute", subType: "statutory_instrument",
    regex: /statutory instrument/,
  },
  // [Name] Act YYYY — case-sensitive: requires capital letter before "Act" + 4-digit year
  {
    jurisdiction: "EN", type: "statute", subType: "act",
    regex: /\bact \d{4}\b/,  // normalized check
    originalRegex: /[A-Z][a-z]+ Act \d{4}\b/,  // must have capital word before Act
  },
];

// DE patterns (non-EU only)
const DE_PATTERNS: PatternDef[] = [
  {
    jurisdiction: "DE", type: "statute", subType: "grundgesetz",
    regex: /grundgesetz/,
  },
  // Verordnung NOT followed by (EU)/(EC)/(EG)
  {
    jurisdiction: "DE", type: "statute", subType: "verordnung",
    regex: /verordnung(?! \((?:eu|ec|eg)\))/,
  },
  // Richtlinie NOT followed by (EU)/(EG)
  {
    jurisdiction: "DE", type: "statute", subType: "richtlinie",
    regex: /richtlinie(?! \((?:eu|eg)\))/,
  },
  {
    jurisdiction: "DE", type: "statute", subType: "beschluss",
    regex: /beschluss/,
  },
  {
    jurisdiction: "DE", type: "statute", subType: "erlass",
    regex: /erlass/,
  },
  {
    jurisdiction: "DE", type: "statute", subType: "satzung",
    regex: /satzung/,
  },
  // Words ending in gesetz or gesetzbuch — case sensitive (must start with capital)
  {
    jurisdiction: "DE", type: "statute", subType: "gesetz",
    regex: /\w*gesetzbuch\b|\w*gesetz\b/,
    originalRegex: /[A-Z]\w*(?:gesetzbuch|gesetz)\b/,
  },
];

// INT patterns
// Protocol must come before convention to avoid "Protocol to the Convention" matching as convention
const INT_PATTERNS: PatternDef[] = [
  {
    jurisdiction: "INT", type: "statute", subType: "treaty",
    regex: /treaty (?:of|on) /,
  },
  {
    jurisdiction: "INT", type: "statute", subType: "protocol",
    regex: /(?:protocol (?:to|on) |additional protocol)/,
  },
  {
    jurisdiction: "INT", type: "statute", subType: "convention",
    regex: /convention (?:on|for|against|relating) /,
  },
  {
    jurisdiction: "INT", type: "statute", subType: "covenant",
    regex: /covenant on /,
  },
  {
    jurisdiction: "INT", type: "statute", subType: "charter",
    regex: /charter (?:of|on) /,
  },
  {
    jurisdiction: "INT", type: "statute", subType: "declaration",
    regex: /universal declaration/,
  },
  // Rome/Geneva/Hague/Vienna Statute
  {
    jurisdiction: "INT", type: "statute", subType: "statute",
    regex: /(?:rome|geneva|hague|vienna) (?:statute|convention)/,
  },
];

// Order matters: EU before DE, FR before RO (Loi n° is FR, not RO)
const ALL_PATTERNS: PatternDef[] = [
  ...EU_PATTERNS,
  ...FR_PATTERNS,
  ...RO_PATTERNS,
  ...EN_PATTERNS,
  ...INT_PATTERNS,
  ...DE_PATTERNS,
];

// ─── Detection ───────────────────────────────────────────────────────

export function isLegislativeReference(title: string): LegislativeMatch | null {
  if (!title || title.length < 3) return null;

  const normalized = normalizeForSearch(title);

  for (const pattern of ALL_PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (!match) continue;

    // If pattern requires original text check (case-sensitive), verify
    if (pattern.originalRegex && !pattern.originalRegex.test(title)) {
      continue;
    }

    return {
      jurisdiction: pattern.jurisdiction,
      type: pattern.type,
      matchedPattern: match[0],
      subType: pattern.subType,
    };
  }

  return null;
}

// ─── Parsing ─────────────────────────────────────────────────────────

const RO_NR_RE = /nr\.\s*(\d+(?:\/\d{4})?)/;
const EU_NUM_RE = /(\d{4}\/\d+)/;
const FR_NUM_RE = /n[°o]?\s*(\d{4}-\d+)/;
const FR_DATE_RE = /du\s+([\d]+(?:er)?\s+\w+\s+\d{4})/;
const EN_YEAR_RE = /Act\s+(\d{4})\b/;
const EN_PL_RE = /(?:Public Law|Pub\. L\.|P\.L\.)\s+(\d+-\d+)/;
const EN_EO_RE = /Executive Order\s+(\d+)/;

const RO_AUTHORITY_MAP: Record<string, string> = {
  lege: "Parlamentul României",
  oug: "Guvernul României",
  og: "Guvernul României",
  hg: "Guvernul României",
  ordin: "Ministerul de resort",
  decizie: "Curtea Constituțională a României",
  cod: "Parlamentul României",
  constitutie: "Parlamentul României",
  decret: "Președintele României",
  "decret-lege": "Președintele României",
  norma: "Autoritatea emitentă",
  instructiune: "Autoritatea emitentă",
  metodologie: "Autoritatea emitentă",
  dispozitie: "Autoritatea emitentă",
};

export function parseLegislativeReference(
  title: string,
  match: LegislativeMatch,
): LegislativeFields {
  const base: LegislativeFields = {
    itemType: match.type,
    title,
    codeNumber: "",
    code: "",
    dateEnacted: "",
    authority: "",
    jurisdiction: "",
  };

  switch (match.jurisdiction) {
    case "RO":
      return parseRO(title, match, base);
    case "EU":
      return parseEU(title, match, base);
    case "FR":
      return parseFR(title, match, base);
    case "EN":
      return parseEN(title, match, base);
    case "DE":
      return parseDE(title, match, base);
    case "INT":
      return parseINT(title, match, base);
    default:
      return base;
  }
}

function parseRO(title: string, match: LegislativeMatch, base: LegislativeFields): LegislativeFields {
  base.jurisdiction = "România";
  base.code = "Monitorul Oficial";
  base.authority = RO_AUTHORITY_MAP[match.subType] || "Autoritatea emitentă";

  // Handle Decizia ÎCCJ separately
  if (/ÎCCJ|ICCJ/.test(title)) {
    base.authority = "Înalta Curte de Casație și Justiție";
  }

  const nrMatch = title.match(RO_NR_RE);
  if (nrMatch) {
    base.codeNumber = nrMatch[1];
    // Extract year from X/YYYY
    const yearMatch = nrMatch[1].match(/\/(\d{4})$/);
    if (yearMatch) {
      base.dateEnacted = yearMatch[1];
    }
  }

  return base;
}

function parseEU(title: string, _match: LegislativeMatch, base: LegislativeFields): LegislativeFields {
  base.jurisdiction = "EU";
  base.code = "OJ";
  base.authority = "European Union";

  const numMatch = title.match(EU_NUM_RE);
  if (numMatch) {
    base.codeNumber = numMatch[1];
    const yearMatch = numMatch[1].match(/^(\d{4})/);
    if (yearMatch) {
      base.dateEnacted = yearMatch[1];
    }
  }

  return base;
}

function parseFR(title: string, _match: LegislativeMatch, base: LegislativeFields): LegislativeFields {
  base.jurisdiction = "France";
  base.code = "Journal officiel";
  base.authority = "République française";

  const numMatch = title.match(FR_NUM_RE);
  if (numMatch) {
    base.codeNumber = numMatch[1];
  }

  const dateMatch = title.match(FR_DATE_RE);
  if (dateMatch) {
    base.dateEnacted = dateMatch[1];
  }

  return base;
}

function parseEN(title: string, match: LegislativeMatch, base: LegislativeFields): LegislativeFields {
  base.jurisdiction = "United Kingdom / United States";
  base.code = "";
  base.authority = "";

  if (match.subType === "act") {
    const yearMatch = title.match(EN_YEAR_RE);
    if (yearMatch) {
      base.dateEnacted = yearMatch[1];
    }
  } else if (match.subType === "public_law") {
    const plMatch = title.match(EN_PL_RE);
    if (plMatch) {
      base.codeNumber = plMatch[1];
    }
  } else if (match.subType === "executive_order") {
    const eoMatch = title.match(EN_EO_RE);
    if (eoMatch) {
      base.codeNumber = eoMatch[1];
    }
  }

  return base;
}

function parseDE(_title: string, _match: LegislativeMatch, base: LegislativeFields): LegislativeFields {
  base.jurisdiction = "Deutschland";
  base.code = "Bundesgesetzblatt";
  base.authority = "Bundesrepublik Deutschland";
  return base;
}

function parseINT(_title: string, _match: LegislativeMatch, base: LegislativeFields): LegislativeFields {
  base.jurisdiction = "International";
  base.code = "";
  base.authority = "International";
  return base;
}

// ─── Apply to Zotero item ────────────────────────────────────────────

export function applyLegislativeFormatting(
  zoteroItem: any,
  fields: LegislativeFields,
): void {
  // Change item type to statute (or bill)
  const typeID = (Zotero as any).ItemTypes.getID(fields.itemType);
  if (typeID) {
    zoteroItem.setType(typeID);
  }

  // Set fields
  if (fields.codeNumber) {
    zoteroItem.setField("codeNumber", fields.codeNumber);
  }
  if (fields.code) {
    zoteroItem.setField("code", fields.code);
  }
  if (fields.dateEnacted) {
    zoteroItem.setField("dateEnacted", fields.dateEnacted);
  }

  // Set authority as corporate author
  const authorTypeID = (Zotero as any).CreatorTypes.getID("author");
  if (fields.authority && authorTypeID !== undefined) {
    zoteroItem.setCreator(0, {
      firstName: "",
      lastName: fields.authority,
      creatorTypeID: authorTypeID,
      fieldMode: 1,
    });
  }
}
