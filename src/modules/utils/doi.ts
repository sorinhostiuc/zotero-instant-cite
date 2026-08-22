/**
 * DOI handling: normalization, structural validation and DOI ↔ record
 * concordance.
 *
 * A DOI is only usable as an identifier if the record it resolves to really is
 * the article the Zotero item describes. Every lookup that starts from a DOI
 * must run its result through `titlesAgree` before any field is written —
 * otherwise one wrong DOI silently rewrites journal, year, volume, pages and
 * authors with a completely different article's metadata.
 */

import { titleSimilarity } from "./deduplicator";

/** Strip URL prefixes, the "doi:" scheme and surrounding whitespace. */
export function normalizeDoi(raw: string | undefined | null): string {
  if (!raw) return "";
  return String(raw)
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

/**
 * A structurally complete DOI: `10.<registrant>/<suffix>`.
 *
 * Reference lists routinely produce truncated DOIs such as
 * "10.1016/j.pec.2021." — the article id is missing. CrossRef 404s on those,
 * but a free-text search matches hundreds of real papers, so a fragment must
 * never be treated as an identifier.
 */
export function isWellFormedDoi(raw: string | undefined | null): boolean {
  const doi = normalizeDoi(raw);
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) return false;
  const suffix = doi.slice(doi.indexOf("/") + 1);
  if (suffix.length < 3) return false;
  // Trailing separator = the suffix was cut off mid-way.
  return !/[.\-/;:,_]$/.test(suffix);
}

/** Case-insensitive DOI equality after normalization. */
export function sameDoi(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizeDoi(a).toLowerCase();
  const nb = normalizeDoi(b).toLowerCase();
  return !!na && na === nb;
}

/** Below this bigram-Jaccard score two titles are treated as different works. */
export const TITLE_AGREEMENT_MIN = 0.55;

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Do these two titles describe the same work?
 *
 * Deliberately permissive — sources differ in subtitle handling, truncation
 * and punctuation — but strict enough to catch "this DOI belongs to another
 * paper". An empty title on either side means there is nothing to contradict,
 * so the check passes.
 */
export function titlesAgree(
  itemTitle: string | undefined | null,
  recordTitle: string | undefined | null,
  min: number = TITLE_AGREEMENT_MIN,
): boolean {
  const a = normalizeTitle(String(itemTitle ?? ""));
  const b = normalizeTitle(String(recordTitle ?? ""));
  if (!a || !b) return true;
  if (a === b) return true;
  // One side truncated or missing the subtitle.
  if (a.includes(b) || b.includes(a)) return true;
  if (titleSimilarity(a, b) >= min) return true;

  // Vocabulary containment — catches reordered subtitles and added series info.
  const wa = new Set(a.split(" "));
  const wb = new Set(b.split(" "));
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  if (small.size < 4) return false;
  let hits = 0;
  for (const w of small) if (big.has(w)) hits++;
  return hits / small.size >= 0.8;
}

/** Query string that pins Europe PMC to an exact DOI instead of free text. */
export function europePmcDoiQuery(doi: string): string {
  return `DOI:"${normalizeDoi(doi)}"`;
}
