import { fetchJSON } from "./base-client";
import { europePmcDoiQuery, isWellFormedDoi } from "../utils/doi";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const BASE_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

export async function searchEuropePMC(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const maxResults = Math.min(options.maxResults ?? 20, 200);

  // A bare DOI must be pinned to the DOI field. As free text Europe PMC
  // tokenizes it — "10.1016/j.pec.2021." alone returns 700+ unrelated papers,
  // and callers that take results[0] would attach the wrong article.
  let query = isWellFormedDoi(options.query)
    ? europePmcDoiQuery(options.query)
    : options.query;
  if (options.yearFrom || options.yearTo) {
    const from = options.yearFrom ?? 1900;
    const to = options.yearTo ?? new Date().getFullYear();
    query += ` PUB_YEAR:[${from} TO ${to}]`;
  }
  if (options.openAccessOnly) {
    query += " OPEN_ACCESS:y";
  }

  const params = new URLSearchParams({
    query,
    format: "json",
    pageSize: String(maxResults),
    resultType: "core",
  });

  const url = `${BASE_URL}?${params.toString()}`;
  const data = await fetchJSON<any>(url);

  const results = parseEuropePMCResults(data);
  return {
    source: "EuropePMC",
    results,
    totalCount: data?.hitCount ?? 0,
    searchTimeMs: Date.now() - start,
  };
}

function parseEuropePMCResults(data: any): PaperResult[] {
  const items = data?.resultList?.result ?? [];
  return items.map((item: any) => {
    const authors: Author[] = (item.authorList?.author ?? []).map((a: any) => {
      // Corporate/collaborative author
      if (a.collectiveName) {
        return { name: a.collectiveName, lastName: a.collectiveName, isCorporate: true };
      }
      const lastName = a.lastName ?? "";
      const firstName = a.initials ?? a.firstName ?? "";
      return {
        name: [lastName, firstName].filter(Boolean).join(" "),
        lastName,
        firstName,
        orcid: a.authorId?.type === "ORCID" ? a.authorId.value : undefined,
        affiliation: a.affiliation ?? undefined,
      };
    }).filter((a: Author) => a.name.trim() !== "");

    const year = parseInt(item.pubYear ?? "0", 10);
    const doi = item.doi ?? undefined;
    const pmid = item.pmid ?? undefined;

    return {
      id: `europepmc:${item.id ?? item.pmid ?? item.doi}`,
      title: item.title ?? "",
      authors,
      year,
      journal: item.journalTitle ?? "",
      issn: item.journalIssn ?? undefined,
      volume: item.journalVolume ?? undefined,
      issue: item.issue ?? undefined,
      pages: item.pageInfo ?? undefined,
      doi,
      pmid,
      abstract: item.abstractText ?? undefined,
      citationCount: item.citedByCount ?? 0,
      isOpenAccess: item.isOpenAccess === "Y",
      pdfUrl: item.fullTextUrlList?.fullTextUrl?.find(
        (u: any) => u.documentStyle === "pdf" && u.availability === "Open access",
      )?.url ?? undefined,
      sources: ["EuropePMC"],
    } as PaperResult;
  });
}
