import type { PaperResult } from "../api/types";
import { isLegislativeReference, parseLegislativeReference } from "./legislative-detector";

export function deduplicateResults(papers: PaperResult[]): PaperResult[] {
  const byDoi = new Map<string, PaperResult>();
  const noDoi: PaperResult[] = [];

  for (const paper of papers) {
    if (paper.doi) {
      const key = paper.doi.toLowerCase();
      const existing = byDoi.get(key);
      if (existing) {
        byDoi.set(key, mergePapers(existing, paper));
      } else {
        byDoi.set(key, paper);
      }
    } else {
      noDoi.push(paper);
    }
  }

  // Deduplicate no-DOI papers: legislative-key match takes priority,
  // otherwise fall back to title similarity.
  const uniqueNoDoi: PaperResult[] = [];
  for (const paper of noDoi) {
    const match = uniqueNoDoi.findIndex(existing => isDuplicate(existing, paper));
    if (match >= 0) {
      uniqueNoDoi[match] = mergePapers(uniqueNoDoi[match], paper);
    } else {
      uniqueNoDoi.push(paper);
    }
  }

  return [...byDoi.values(), ...uniqueNoDoi];
}

/**
 * Two items are duplicates if:
 *  - both are legislative references with matching legal keys, OR
 *  - neither is a legislative reference and titles are >80% similar.
 *
 * If exactly one is legislative we never merge — they aren't the same kind
 * of object, even if titles happen to overlap.
 */
function isDuplicate(a: PaperResult, b: PaperResult): boolean {
  const legalA = isLegislativeReference(a.title);
  const legalB = isLegislativeReference(b.title);

  if (legalA && legalB) {
    return legalKeysMatch(a, legalA, b, legalB);
  }
  if (legalA || legalB) {
    return false;
  }
  return titleSimilarity(a.title, b.title) > 0.80;
}

/**
 * Compare two detected legislative items. Match requires same jurisdiction
 * and same subType. The codeNumber must either match exactly, or one side
 * may omit the year/suffix (e.g. "Legea 46" matches "Legea 46/2003" because
 * users frequently cite without the year).
 */
function legalKeysMatch(
  a: PaperResult, matchA: ReturnType<typeof isLegislativeReference>,
  b: PaperResult, matchB: ReturnType<typeof isLegislativeReference>,
): boolean {
  if (!matchA || !matchB) return false;
  if (matchA.jurisdiction !== matchB.jurisdiction) return false;
  if (matchA.subType !== matchB.subType) return false;

  const fa = parseLegislativeReference(a.title, matchA);
  const fb = parseLegislativeReference(b.title, matchB);
  if (!fa.codeNumber || !fb.codeNumber) return false;

  if (fa.codeNumber === fb.codeNumber) return true;

  // Partial match — one cite has year/suffix, the other doesn't.
  // codeNumber forms: "46/2003" (RO), "2016/679" (EU), "2016-1691" (FR), "111-148" (US).
  const [numA] = fa.codeNumber.split(/[/-]/);
  const [numB] = fb.codeNumber.split(/[/-]/);
  const aBare = numA === fa.codeNumber;
  const bBare = numB === fb.codeNumber;
  return numA === numB && aBare !== bBare;
}

/**
 * Combine two records of the same work. `a` wins on every field it actually
 * has; `b` fills the gaps.
 *
 * Enumerating fields here is what used to break: volume, issue, pages, ISSN,
 * isbn, itemType and the legal fields were simply dropped, so a merged book
 * came out of dedup as a journalArticle with no pagination. Copying `a`
 * wholesale and back-filling from `b` keeps every field a source provided,
 * including ones added to PaperResult later.
 */
function mergePapers(a: PaperResult, b: PaperResult): PaperResult {
  const merged: any = { ...a };

  for (const [key, value] of Object.entries(b as any)) {
    if (value === undefined || value === null || value === "") continue;
    const current = merged[key];
    if (current === undefined || current === null || current === "") merged[key] = value;
  }

  // Fields where "present" is not the right rule.
  merged.id = a.id;
  merged.title = a.title.length >= b.title.length ? a.title : b.title;
  merged.authors = a.authors.length >= b.authors.length ? a.authors : b.authors;
  merged.year = a.year || b.year;
  merged.citationCount = Math.max(a.citationCount ?? 0, b.citationCount ?? 0);
  merged.isOpenAccess = a.isOpenAccess || b.isOpenAccess;
  merged.sources = [...new Set([...a.sources, ...b.sources])];

  // Preserve Zotero item ID if either paper has one (already in library)
  const zoteroId = (a as any)._zoteroItemId ?? (b as any)._zoteroItemId;
  if (zoteroId) merged._zoteroItemId = zoteroId;
  return merged;
}

/** Jaccard similarity on word bigrams — fast and good enough for title matching */
export function titleSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const na = normalize(a);
  const nb = normalize(b);

  if (na === nb) return 1.0;
  if (!na || !nb) return 0.0;

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    const words = s.split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
      set.add(`${words[i]} ${words[i + 1]}`);
    }
    // Also add individual words for short titles
    for (const w of words) set.add(w);
    return set;
  };

  const setA = bigrams(na);
  const setB = bigrams(nb);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
