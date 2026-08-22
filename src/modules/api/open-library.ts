import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const BASE_URL = "https://openlibrary.org/search.json";

export async function searchOpenLibrary(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const maxResults = options.maxResults ?? 20;

  const params = new URLSearchParams({
    q: options.query,
    limit: String(maxResults),
    fields: "key,title,author_name,first_publish_year,publisher,isbn,number_of_pages_median,subject,edition_count",
  });

  const url = `${BASE_URL}?${params.toString()}`;
  const data = await fetchJSON<any>(url);

  const docs = data?.docs ?? [];
  const totalCount = data?.numFound ?? 0;

  const results: PaperResult[] = docs.map((doc: any) => {
    const authors: Author[] = (doc.author_name ?? []).map((name: string) => ({ name }));
    const year = doc.first_publish_year ?? 0;

    // Filter by year if specified
    if (options.yearFrom && year < options.yearFrom) return null;
    if (options.yearTo && year > options.yearTo) return null;

    const isbn = doc.isbn?.[0] ?? undefined;

    return {
      id: `openlibrary:${doc.key}`,
      title: doc.title ?? "",
      authors,
      year,
      journal: (doc.publisher ?? []).join(", "),
      doi: undefined,
      pmid: undefined,
      abstract: doc.subject ? `Subjects: ${doc.subject.slice(0, 5).join(", ")}` : undefined,
      citationCount: doc.edition_count ?? 0,
      isOpenAccess: false,
      isbn,
      sources: ["OpenLibrary"],
    } as PaperResult;
  }).filter(Boolean) as PaperResult[];

  return {
    source: "OpenLibrary",
    results,
    totalCount,
    searchTimeMs: Date.now() - start,
  };
}
