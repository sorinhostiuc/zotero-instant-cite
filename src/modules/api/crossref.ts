import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const BASE_URL = "https://api.crossref.org/works";
const MAILTO = "sorin.hostiuc@umfcd.ro";
const DOI_RE = /^10\.\d{4,}\/\S+$/;

function isDOI(query: string): boolean {
  const stripped = query.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return DOI_RE.test(stripped);
}

function normalizeDOI(query: string): string {
  return query.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
}

export async function searchCrossRef(options: SearchOptions): Promise<SearchResponse> {
  // DOI queries get the dedicated /works/{DOI} endpoint — single canonical hit
  // instead of a 100-result text search where the requested DOI may not even
  // make the top of the relevance ranking.
  if (isDOI(options.query)) {
    return lookupCrossRefDOI(normalizeDOI(options.query));
  }

  const start = Date.now();
  const maxResults = options.maxResults ?? 20;

  const params = new URLSearchParams({
    query: options.query,
    rows: String(maxResults),
    mailto: MAILTO,
    sort: "relevance",
    order: "desc",
  });

  // Year filter
  if (options.yearFrom) {
    params.set("filter", `from-pub-date:${options.yearFrom}`);
  }
  if (options.yearTo) {
    const existing = params.get("filter") || "";
    const toFilter = `until-pub-date:${options.yearTo}`;
    params.set("filter", existing ? `${existing},${toFilter}` : toFilter);
  }

  const url = `${BASE_URL}?${params.toString()}`;
  const data = await fetchJSON<any>(url);

  const items = data?.message?.items ?? [];
  const totalCount = data?.message?.["total-results"] ?? 0;
  const results: PaperResult[] = items.map(mapCrossRefItem);

  return {
    source: "CrossRef",
    results,
    totalCount,
    searchTimeMs: Date.now() - start,
  };
}

/**
 * Direct DOI lookup against /works/{DOI}. Returns 1 result if the DOI is
 * registered with CrossRef, 0 results on 404 (so the orchestrator can fall
 * back to text search). Other errors propagate.
 */
export async function lookupCrossRefDOI(doi: string): Promise<SearchResponse> {
  const start = Date.now();
  // CrossRef requires the raw DOI in the path; do not encode the slash.
  // encodeURIComponent on "10.1007/s11606-020-06407-8" would turn "/" into
  // "%2F" and the API returns 404. Encode only the parts after the slash.
  const slashIdx = doi.indexOf("/");
  const prefix = doi.slice(0, slashIdx);
  const suffix = doi.slice(slashIdx + 1);
  const url = `${BASE_URL}/${prefix}/${encodeURIComponent(suffix)}?mailto=${encodeURIComponent(MAILTO)}`;

  try {
    const data = await fetchJSON<any>(url);
    const item = data?.message;
    if (!item) {
      return { source: "CrossRef", results: [], totalCount: 0, searchTimeMs: Date.now() - start };
    }
    return {
      source: "CrossRef",
      results: [mapCrossRefItem(item)],
      totalCount: 1,
      searchTimeMs: Date.now() - start,
    };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("HTTP 404")) {
      // DOI not registered with CrossRef — empty result, not an error.
      return { source: "CrossRef", results: [], totalCount: 0, searchTimeMs: Date.now() - start };
    }
    throw e;
  }
}

/** Largest batch `lookupCrossRefDOIBatch` sends in one request. */
export const DOI_BATCH_SIZE = 50;

/**
 * Resolve many DOIs in a single request.
 *
 * CrossRef treats a repeated filter key as OR, so `filter=doi:a,doi:b,...`
 * returns every matching record at once. Verifying a whole library drops from
 * one request per item to one per fifty.
 *
 * DOIs the API does not return are simply absent from the map. That is not the
 * same as "not registered" — a batch can also come back short — so the caller
 * must retry the missing ones individually before concluding anything.
 */
export async function lookupCrossRefDOIBatch(dois: string[]): Promise<Map<string, PaperResult>> {
  const found = new Map<string, PaperResult>();
  const clean = dois.map(d => normalizeDOI(String(d ?? ""))).filter(d => d.length > 0);
  if (clean.length === 0) return found;

  const params = new URLSearchParams({
    filter: clean.map(d => `doi:${d}`).join(","),
    rows: String(clean.length),
    mailto: MAILTO,
  });

  const data = await fetchJSON<any>(`${BASE_URL}?${params.toString()}`);
  for (const item of data?.message?.items ?? []) {
    const paper = mapCrossRefItem(item);
    if (paper.doi) found.set(paper.doi.toLowerCase(), paper);
  }
  return found;
}

function mapCrossRefItem(item: any): PaperResult {
  const authors: Author[] = (item.author ?? []).map((a: any) => {
    // CrossRef shapes: {family, given} for persons; {name} alone for orgs.
    const orcid = a.ORCID?.replace(/^https?:\/\/orcid\.org\//, "") ?? undefined;
    const affiliation = a.affiliation?.[0]?.name ?? undefined;
    if (a.name && !a.family && !a.given) {
      // Standalone name = corporate/collective
      return { name: a.name, lastName: a.name, isCorporate: true, orcid, affiliation };
    }
    const lastName = (a.family ?? "").trim();
    const firstName = (a.given ?? "").trim();
    const displayName = lastName && firstName ? `${lastName}, ${firstName}` : (lastName || firstName);
    return { name: displayName, lastName, firstName, orcid, affiliation };
  }).filter((a: Author) => (a.name ?? "").trim() !== "");

  const year = item.published?.["date-parts"]?.[0]?.[0] ??
    item["published-print"]?.["date-parts"]?.[0]?.[0] ??
    item["published-online"]?.["date-parts"]?.[0]?.[0] ?? 0;

  const doi = item.DOI ?? undefined;

  // ISSN — CrossRef provides issn-type array with type + value pairs
  let issn: string | undefined;
  const issnTypes: any[] = item["issn-type"] ?? [];
  const issnObj = issnTypes.find((i: any) => i.type === "print") ?? issnTypes[0];
  if (issnObj?.value) issn = issnObj.value;

  // Journal abbreviation — CrossRef puts it in short-container-title
  const journalAbbreviation: string | undefined = Array.isArray(item["short-container-title"])
    ? item["short-container-title"][0] ?? undefined
    : item["short-container-title"] ?? undefined;

  // Book fields
  const crossrefType: string = item.type ?? "";
  const isBook = crossrefType === "book" || crossrefType === "monograph" ||
    crossrefType === "edited-book" || crossrefType === "reference-book" ||
    crossrefType === "book-set";
  const publisher: string | undefined = item.publisher ?? undefined;
  const place: string | undefined = item["publisher-location"] ?? undefined;

  // For books, use publisher as journal (bridge maps journal→publisher for books)
  const journal: string = Array.isArray(item["container-title"])
    ? item["container-title"][0] ?? ""
    : item["container-title"] ?? "";

  return {
    id: `crossref:${doi || item.URL}`,
    title: Array.isArray(item.title) ? item.title[0] ?? "" : item.title ?? "",
    authors,
    year,
    journal: journal || publisher || "",
    journalAbbreviation,
    issn,
    volume: item.volume ?? undefined,
    issue: item.issue ?? undefined,
    pages: item.page ?? undefined,
    publisher: isBook ? publisher : undefined,
    place,
    itemType: isBook ? "book" : undefined,
    doi,
    abstract: item.abstract?.replace(/<[^>]*>/g, "") ?? undefined,
    citationCount: item["is-referenced-by-count"] ?? 0,
    isOpenAccess: item.license?.some((l: any) => l.URL?.includes("creativecommons")) ?? false,
    sources: ["CrossRef"],
  } as PaperResult;
}
