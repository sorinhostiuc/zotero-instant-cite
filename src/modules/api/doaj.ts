import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const BASE_URL = "https://doaj.org/api/search/articles";

export async function searchDOAJ(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const maxResults = Math.min(options.maxResults ?? 20, 100);
  const pageSize = Math.min(maxResults, 50); // DOAJ max page size is 50

  let query = options.query;
  if (options.yearFrom || options.yearTo) {
    const from = options.yearFrom ?? 1900;
    const to = options.yearTo ?? new Date().getFullYear();
    query += ` AND bibjson.year:[${from} TO ${to}]`;
  }

  const url = `${BASE_URL}/${encodeURIComponent(query)}?pageSize=${pageSize}`;
  const data = await fetchJSON<any>(url);

  const results = parseDOAJResults(data);
  return {
    source: "DOAJ",
    results,
    totalCount: data?.total ?? 0,
    searchTimeMs: Date.now() - start,
  };
}

function parseDOAJResults(data: any): PaperResult[] {
  const items = data?.results ?? [];
  return items.map((item: any) => {
    const bib = item.bibjson ?? {};

    const authors: Author[] = (bib.author ?? []).map((a: any) => ({
      name: a.name ?? "",
      orcid: a.orcid_id ?? undefined,
      affiliation: a.affiliation?.name ?? undefined,
    }));

    const year = parseInt(bib.year ?? "0", 10);

    // Find DOI from identifiers
    const doiObj = (bib.identifier ?? []).find((id: any) => id.type === "doi");
    const doi = doiObj?.id?.replace("https://doi.org/", "") ?? undefined;

    // ISSN from identifiers
    const issnObj = (bib.identifier ?? []).find((id: any) => id.type === "pissn" || id.type === "eissn");
    const issn = issnObj?.id ?? undefined;

    // Pages: combine start_page + end_page if both exist
    let pages: string | undefined;
    if (bib.start_page) {
      pages = bib.start_page;
      if (bib.end_page) pages += "-" + bib.end_page;
    }

    // Find best link
    const links = bib.link ?? [];
    const pdfLink = links.find((l: any) => l.type === "fulltext" && l.content_type === "application/pdf");
    const fullTextLink = links.find((l: any) => l.type === "fulltext");

    return {
      id: `doaj:${item.id}`,
      title: bib.title ?? "",
      authors,
      year,
      journal: bib.journal?.title ?? "",
      issn,
      volume: bib.journal?.volume ?? undefined,
      issue: bib.journal?.number ?? bib.journal?.issue ?? undefined,
      pages,
      doi,
      abstract: bib.abstract ?? undefined,
      citationCount: 0,
      isOpenAccess: true, // Everything in DOAJ is open access
      pdfUrl: pdfLink?.url ?? fullTextLink?.url ?? undefined,
      sources: ["DOAJ"],
    } as PaperResult;
  });
}
