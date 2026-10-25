import { fetchJSON, redactSecrets } from "./base-client";
import { getOpenAlexApiKey } from "../preferences";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const BASE_URL = "https://api.openalex.org/works";

/** OpenAlex work types behind each advanced-search document kind */
const OPENALEX_TYPES: Record<string, string[]> = {
  article: ["article", "preprint", "review", "letter", "editorial"],
  book: ["book"],
  chapter: ["book-chapter", "reference-entry"],
  thesis: ["dissertation"],
};

/** Filter values are comma-separated, so a comma inside one would split it. */
function filterValue(text: string): string {
  return text.replace(/[,|:]/g, " ").replace(/\s+/g, " ").trim();
}

function withApiKey(params: URLSearchParams): URLSearchParams {
  const key = getOpenAlexApiKey();
  if (key) params.set("api_key", key);
  return params;
}

export async function searchOpenAlex(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  // A larger page costs no more credits, but anonymous calls share a small
  // daily quota, so keep the payload modest.
  const maxResults = Math.min(options.maxResults ?? 20, 25);

  const params = new URLSearchParams({ per_page: String(maxResults) });
  const fields = options.fields;
  const filters: string[] = [];
  if (fields && (fields.title?.trim() || fields.author?.trim())) {
    if (fields.text?.trim()) params.set("search", fields.text.trim());
    if (fields.title?.trim()) filters.push(`title.search:${filterValue(fields.title)}`);
    if (fields.author?.trim()) filters.push(`raw_author_name.search:${filterValue(fields.author)}`);
  } else {
    params.set("search", options.query);
  }
  const types = OPENALEX_TYPES[fields?.itemType ?? ""];
  if (types) filters.push(`type:${types.join("|")}`);
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

  const url = `${BASE_URL}?${withApiKey(params).toString()}`;
  Zotero.log("[InstantCite] OpenAlex URL: " + redactSecrets(url));
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

/** Fetch one work by its OpenAlex ID (W123...). */
export async function lookupOpenAlexWork(id: string): Promise<SearchResponse> {
  const start = Date.now();
  const params = withApiKey(new URLSearchParams());
  const query = params.toString();
  const url = `${BASE_URL}/${encodeURIComponent(id.toUpperCase())}${query ? "?" + query : ""}`;
  const work = await fetchJSON<any>(url);
  const results = work?.id ? parseOpenAlexResults({ results: [work] }) : [];
  return { source: "OpenAlex", results, totalCount: results.length, searchTimeMs: Date.now() - start };
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

    const itemType = OPENALEX_ITEM_TYPES[work.type ?? ""];
    const source = work.primary_location?.source;
    const host = source?.display_name ?? "";
    const isbn = Array.isArray(work.ids?.isbn) ? work.ids.isbn[0] : undefined;

    return {
      id: `openalex:${work.id}`,
      itemType,
      isbn,
      title: work.title ?? "",
      authors,
      year: work.publication_year ?? 0,
      // A thesis host is the repository, a book host is the publisher series:
      // neither is a journal name.
      journal: itemType === "thesis" || itemType === "book" ? "" : host,
      publisher: itemType === "thesis" || itemType === "book"
        ? source?.host_organization_name ?? (host || undefined)
        : undefined,
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

/** Zotero item types for OpenAlex work types; anything else stays an article */
const OPENALEX_ITEM_TYPES: Record<string, string> = {
  "book": "book",
  "book-chapter": "bookSection",
  "dissertation": "thesis",
  "reference-entry": "bookSection",
};

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
