import type { AdvancedFields, AdvancedItemType, PaperResult, SearchOptions } from "../api/types";
import { normalizeForSearch } from "./text-normalizer";

/**
 * Sources worth asking for each document kind. A book search gains nothing
 * from PubMed, and a court decision is never in CrossRef, so the advanced
 * type also prunes the source list (the result filter still applies).
 */
export const TYPE_SOURCES: Record<AdvancedItemType, string[]> = {
  article: ["Zotero", "PubMed", "EuropePMC", "CrossRef", "OpenAlex", "DOAJ", "BCUB"],
  book: ["Zotero", "CrossRef", "OpenAlex", "OpenLibrary", "LoC", "BCUB"],
  chapter: ["Zotero", "CrossRef", "OpenAlex"],
  thesis: ["Zotero", "CrossRef", "OpenAlex", "BCUB", "LoC"],
  legal: ["Zotero", "ECHR", "EUR-Lex", "RO-Lex", "CourtListener"],
};

const LEGAL_TYPES = new Set(["case", "statute", "bill", "hearing", "regulation"]);
const ARTICLE_TYPES = new Set([
  "journalArticle", "magazineArticle", "newspaperArticle", "conferencePaper", "preprint",
]);

/** True when the advanced panel constrains anything beyond the free text. */
export function hasAdvancedFields(fields?: AdvancedFields): boolean {
  return !!fields && !!(fields.title?.trim() || fields.author?.trim() ||
    fields.identifier?.trim() || fields.itemType);
}

/**
 * Text every source can search: the free text plus the title and author
 * terms. Sources that support fielded queries use the parts instead.
 */
export function buildCombinedQuery(query: string, fields?: AdvancedFields): string {
  return [query, fields?.title, fields?.author]
    .map(part => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Parse the advanced year field: "2020", "2015-2020", "2015-" or "-2020".
 * Returns null for anything else so the caller can keep the year filter bar.
 */
export function parseYearRange(raw: string): { yearFrom?: number; yearTo?: number } | null {
  const m = raw.trim().match(/^(\d{4})?\s*(?:[-–]\s*(\d{4})?)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const hasDash = /[-–]/.test(raw);
  const from = m[1] ? parseInt(m[1], 10) : undefined;
  const to = m[2] ? parseInt(m[2], 10) : hasDash ? undefined : from;
  if (from !== undefined && to !== undefined && from > to) return { yearFrom: to, yearTo: from };
  return { yearFrom: from, yearTo: to };
}

/** Zotero item type a result will be saved as, mirroring the bridge's default. */
export function effectiveItemType(paper: PaperResult): string {
  return paper.itemType || (paper.isbn ? "book" : "journalArticle");
}

export function matchesItemType(paper: PaperResult, type: AdvancedItemType): boolean {
  const itemType = effectiveItemType(paper);
  switch (type) {
    case "article": return ARTICLE_TYPES.has(itemType);
    case "book": return itemType === "book";
    case "chapter": return itemType === "bookSection" || itemType === "encyclopediaArticle" ||
      itemType === "dictionaryEntry";
    case "thesis": return itemType === "thesis";
    case "legal": return LEGAL_TYPES.has(itemType);
  }
  return true;
}

/** Search terms of at least two characters, accent- and case-insensitive. */
export function searchTerms(text: string): string[] {
  return normalizeForSearch(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 2);
}

function authorText(paper: PaperResult): string[] {
  return (paper.authors ?? []).map(a =>
    normalizeForSearch([a.name, a.lastName, a.firstName].filter(Boolean).join(" ")));
}

/**
 * Whether a result satisfies the fielded constraints. Most sources only take
 * free text, so this is what makes "title" mean title for all of them.
 */
export function matchesAdvanced(paper: PaperResult, options: SearchOptions): boolean {
  const fields = options.fields;
  if (!fields) return true;

  const titleTerms = searchTerms(fields.title ?? "");
  if (titleTerms.length > 0) {
    const title = normalizeForSearch(paper.title ?? "");
    if (!titleTerms.every(t => title.includes(t))) return false;
  }

  const authorTerms = searchTerms(fields.author ?? "");
  if (authorTerms.length > 0) {
    // All terms must hit the same person, so "Pop Ion" does not match a
    // paper by Ion Ionescu and Maria Pop.
    if (!authorText(paper).some(name => authorTerms.every(t => name.includes(t)))) return false;
  }

  if (fields.itemType && !matchesItemType(paper, fields.itemType)) return false;

  // Undated records stay: catalogues often lack a year, and dropping them
  // would hide exactly the items a fielded search is meant to find.
  if (paper.year) {
    if (options.yearFrom && paper.year < options.yearFrom) return false;
    if (options.yearTo && paper.year > options.yearTo) return false;
  }
  return true;
}

/** Restrict the enabled sources to the ones that hold the requested kind. */
export function sourcesForType(enabled: Iterable<string>, type?: AdvancedItemType): Set<string> {
  const set = new Set(enabled);
  if (!type) return set;
  const allowed = new Set(TYPE_SOURCES[type]);
  return new Set([...set].filter(s => allowed.has(s)));
}

/** Words safe to put in a fielded query: query-syntax characters removed. */
export function plainWords(text?: string): string[] {
  return (text ?? "")
    .replace(/["()[\]{}:^~*?\/!+&|<>=]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 2);
}

/**
 * The surname-like term of an author entry ("Ion Pop", "Pop, I." → "Pop"
 * is not knowable, so take the longest word). Engines that want a specific
 * author format get this one term; the result filter checks the rest.
 */
export function primaryAuthorTerm(author?: string): string {
  return plainWords(author).reduce((best, w) => (w.length > best.length ? w : best), "");
}

/**
 * Lucene/Entrez style query for engines with field tags: the free text plus
 * one tagged clause per title word and one for the author.
 */
export function buildFieldedQuery(
  fields: AdvancedFields,
  tag: { title: (word: string) => string; author: (word: string) => string },
): string {
  const parts: string[] = [];
  const text = fields.text?.trim();
  if (text) parts.push(text);
  for (const w of plainWords(fields.title)) parts.push(tag.title(w));
  const author = primaryAuthorTerm(fields.author);
  if (author) parts.push(tag.author(author));
  return parts.join(" AND ");
}

/** Whether the request carries title or author constraints a source can map to its own fields. */
export function hasFieldedTerms(options: SearchOptions): boolean {
  return !!(options.fields?.title?.trim() || options.fields?.author?.trim());
}
