import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const BASE_URL = "https://api.openalex.org/works";

export async function searchOpenAlex(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const maxResults = Math.min(options.maxResults ?? 20, 25); // Keep small for anonymous pool (no API key)

  const params = new URLSearchParams({
    search: options.query,
    per_page: String(maxResults),
  });

  // Build filters
  const filters: string[] = [];
  if (options.yearFrom || options.yearTo) {
    const from = options.yearFrom ?? 1900;
    const to = options.yearTo ?? new Date().getFullYear();
    filters.push(`publication_year:${from}-${to}`);
  }
  if (options.openAccessOnly) {
    filters.push("open_access.is_oa:true");
  }
  if (filters.length > 0) {
    params.set("filter", filters.join(","));
  }

  const url = `${BASE_URL}?${params.toString()}`;
  Zotero.log("[InstantCite] OpenAlex URL: " + url);
  const data = await fetchJSON<any>(url);
  Zotero.log("[InstantCite] OpenAlex results: " + (data?.results?.length ?? 0));

  const results = parseOpenAlexResults(data);
  return {
    source: "OpenAlex",
    results,
    totalCount: data?.meta?.count ?? 0,
    searchTimeMs: Date.now() - start,
  };
}

export function parseOpenAlexResults(data: any): PaperResult[] {
  const works = data?.results ?? [];
  return works.map((work: any) => {
    const authors: Author[] = (work.authorships ?? []).map((a: any) => ({
      name: a.author?.display_name ?? "",
      orcid: a.author?.orcid ?? undefined,
      affiliation: a.institutions?.[0]?.display_name ?? undefined,
    }));

    // DOI: strip "https://doi.org/" prefix
    const rawDoi = work.doi ?? "";
    const doi = rawDoi.replace("https://doi.org/", "");

    // Abstract from inverted index
    const abstract = work.abstract_inverted_index
      ? reconstructAbstract(work.abstract_inverted_index)
      : undefined;

    // Biblio metadata (pages, volume, issue)
    const biblio = work.biblio ?? {};
    const volume = biblio.volume ?? undefined;
    const issue = biblio.issue ?? undefined;
    let pages: string | undefined;
    if (biblio.first_page) {
      pages = biblio.first_page;
      if (biblio.last_page) pages += "-" + biblio.last_page;
    }

    // ISSN from primary location
    const issn = work.primary_location?.source?.issn_l ?? work.primary_location?.source?.issn?.[0] ?? undefined;

    return {
      id: `openalex:${work.id}`,
      title: work.title ?? "",
      authors,
      year: work.publication_year ?? 0,
      journal: work.primary_location?.source?.display_name ?? "",
      issn,
      volume,
      issue,
      pages,
      doi: doi || undefined,
      openalexId: work.id?.replace("https://openalex.org/", "") ?? undefined,
      abstract,
      citationCount: work.cited_by_count ?? 0,
      isOpenAccess: work.open_access?.is_oa ?? false,
      pdfUrl: work.open_access?.oa_url ?? undefined,
      sources: ["OpenAlex"],
    } as PaperResult;
  });
}

/** Reconstruct abstract from OpenAlex inverted index format */
export function reconstructAbstract(invertedIndex: Record<string, number[]>): string {
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, word]) => word).join(" ");
}
