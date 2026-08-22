import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const BASE_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
// Request fewer fields to reduce response size and avoid rate limits
const FIELDS = "title,authors,year,venue,externalIds,abstract,citationCount,isOpenAccess,openAccessPdf,journal";

export async function searchSemanticScholar(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  // S2 free tier has aggressive rate limits — keep requests small
  const maxResults = Math.min(options.maxResults ?? 20, 20); // S2 free tier: aggressive rate limits

  const params = new URLSearchParams({
    query: options.query,
    limit: String(maxResults),
    fields: FIELDS,
  });

  // Year filter
  if (options.yearFrom || options.yearTo) {
    const from = options.yearFrom ?? 1900;
    const to = options.yearTo ?? new Date().getFullYear();
    params.set("year", `${from}-${to}`);
  }

  if (options.openAccessOnly) {
    params.set("openAccessPdf", "");
  }

  const url = `${BASE_URL}?${params.toString()}`;
  const data = await fetchJSON<any>(url);

  const papers = data?.data ?? [];
  const totalCount = data?.total ?? 0;

  const results: PaperResult[] = papers.map((paper: any) => {
    const authors: Author[] = (paper.authors ?? []).map((a: any) => ({
      name: a.name ?? "",
    }));

    const externalIds = paper.externalIds ?? {};

    // Journal metadata from S2 paper object
    const journalInfo = paper.journal ?? {};

    return {
      id: `s2:${paper.paperId}`,
      title: paper.title ?? "",
      authors,
      year: paper.year ?? 0,
      journal: paper.venue ?? journalInfo.name ?? "",
      volume: journalInfo.volume ?? undefined,
      issue: journalInfo.issue ?? undefined,
      pages: journalInfo.pages ?? undefined,
      doi: externalIds.DOI ?? undefined,
      pmid: externalIds.PubMed ?? undefined,
      abstract: paper.abstract ?? undefined,
      citationCount: paper.citationCount ?? 0,
      isOpenAccess: paper.isOpenAccess ?? false,
      pdfUrl: paper.openAccessPdf?.url ?? undefined,
      sources: ["SemanticScholar"],
    } as PaperResult;
  });

  return {
    source: "SemanticScholar",
    results,
    totalCount,
    searchTimeMs: Date.now() - start,
  };
}
