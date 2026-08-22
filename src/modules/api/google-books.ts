import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const BASE_URL = "https://www.googleapis.com/books/v1/volumes";

/**
 * Google Books API — public anonymous access (~1000 req/day quota).
 * No key required for basic search; no special headers needed.
 *
 * Filters by year client-side because the API only accepts a single
 * `&filter=` per request and date filtering isn't a supported filter type.
 */
export async function searchGoogleBooks(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  // Google Books caps maxResults at 40 per request
  const maxResults = Math.min(options.maxResults ?? 20, 40);

  // ISBN search needs the special prefix; otherwise plain text
  const query = isISBN(options.query)
    ? `isbn:${options.query.replace(/[-\s]/g, "")}`
    : options.query;

  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
    printType: "books",
    projection: "lite",
  });

  const url = `${BASE_URL}?${params.toString()}`;
  const data = await fetchJSON<any>(url);

  const items = data?.items ?? [];
  const totalCount = data?.totalItems ?? 0;

  const results: PaperResult[] = [];
  for (const item of items) {
    const v = item?.volumeInfo;
    if (!v) continue;

    const year = parseYear(v.publishedDate);

    // Year filter client-side
    if (options.yearFrom && year < options.yearFrom) continue;
    if (options.yearTo && year > options.yearTo) continue;

    const authors: Author[] = (v.authors ?? []).map((name: string) => ({ name }));

    // Prefer ISBN_13, fall back to ISBN_10
    const ids: Array<{ type: string; identifier: string }> = v.industryIdentifiers ?? [];
    const isbn13 = ids.find(i => i.type === "ISBN_13")?.identifier;
    const isbn10 = ids.find(i => i.type === "ISBN_10")?.identifier;
    const isbn = isbn13 || isbn10;

    // Build a clean title — Google often splits subtitle off
    let title = v.title ?? "";
    if (v.subtitle) title += ": " + v.subtitle;

    // Page URL — info link is the consumer-facing Google Books page
    const pageUrl = v.infoLink || v.canonicalVolumeLink || undefined;

    results.push({
      id: `googlebooks:${item.id}`,
      title,
      authors,
      year,
      // Bridge maps `journal` → `publisher` when itemType is "book"
      journal: v.publisher,
      doi: undefined,
      isbn,
      abstract: v.description ?? undefined,
      isOpenAccess: !!item?.accessInfo?.publicDomain,
      url: pageUrl,
      itemType: "book",
      sources: ["GoogleBooks"],
    } as PaperResult);
  }

  return {
    source: "GoogleBooks",
    results,
    totalCount,
    searchTimeMs: Date.now() - start,
  };
}

function parseYear(dateStr: string | undefined): number {
  if (!dateStr) return 0;
  const m = String(dateStr).match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : 0;
}

function isISBN(query: string): boolean {
  const cleaned = query.replace(/[-\s]/g, "");
  return /^\d{9}[\dX]$/i.test(cleaned) || /^\d{13}$/.test(cleaned);
}
