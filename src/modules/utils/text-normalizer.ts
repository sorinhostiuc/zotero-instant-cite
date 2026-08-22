const LIGATURES: Record<string, string> = {
  "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi",
  "\uFB04": "ffl", "\uFB05": "st", "\uFB06": "st",
  "\uA732": "AA", "\uA733": "aa",
  "\u00C6": "AE", "\u00E6": "ae", "\u0152": "OE", "\u0153": "oe",
};

const LIGATURE_RE = new RegExp("[" + Object.keys(LIGATURES).join("") + "]", "g");

const TYPO_MAP: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"'],
  [/[\u2013\u2014\u2012\u2010\u2011\u2212\u2043]/g, "-"],
  [/\u2026/g, "..."],
];

const RO_CEDILLA_DISPLAY: Array<[RegExp, string]> = [
  [/\u015F/g, "\u0219"], [/\u015E/g, "\u0218"],
  [/\u0163/g, "\u021B"], [/\u0162/g, "\u021A"],
];

const RO_CEDILLA_SEARCH: Array<[RegExp, string]> = [
  [/[\u015F\u0219]/g, "s"], [/[\u015E\u0218]/g, "s"],
  [/[\u0163\u021B]/g, "t"], [/[\u0162\u021A]/g, "t"],
];

function replaceLigatures(text: string): string {
  return text.replace(LIGATURE_RE, (ch) => LIGATURES[ch] ?? ch);
}

function replaceTypographic(text: string): string {
  let result = text;
  for (const [re, repl] of TYPO_MAP) { result = result.replace(re, repl); }
  return result;
}

export function normalizeForSearch(text: string): string {
  if (!text) return "";
  let result = text;
  result = replaceLigatures(result);
  result = replaceTypographic(result);
  for (const [re, repl] of RO_CEDILLA_SEARCH) { result = result.replace(re, repl); }
  result = result.normalize("NFD").replace(/[\u0300-\u036F]/g, "");
  result = result.replace(/[\u00B0\u00B2\u00B3\u00B9\u2070-\u209F]/g, "");
  result = result.toLowerCase();
  result = result.replace(/\s+/g, " ").trim();
  return result;
}

export function normalizeForDisplay(text: string): string {
  if (!text) return "";
  let result = text;
  result = replaceLigatures(result);
  result = replaceTypographic(result);
  for (const [re, repl] of RO_CEDILLA_DISPLAY) { result = result.replace(re, repl); }
  result = result.replace(/\s+/g, " ").trim();
  return result;
}
