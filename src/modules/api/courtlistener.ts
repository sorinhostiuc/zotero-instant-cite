import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse } from "./types";

const BASE_URL = "https://www.courtlistener.com/api/rest/v4/search/";

export async function searchCourtListener(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const maxResults = Math.min(options.maxResults ?? 20, 50);

  const terms = options.query.trim();
  if (!terms) {
    return { source: "CourtListener", results: [], totalCount: 0, searchTimeMs: 0 };
  }

  // Build query parameters
  const params = new URLSearchParams({
    q: terms,
    type: "o",              // opinions
    format: "json",
    stat_Published: "on",   // published opinions only
  });

  // Date filters
  if (options.yearFrom) {
    params.set("filed_after", `${options.yearFrom}-01-01`);
  }
  if (options.yearTo) {
    params.set("filed_before", `${options.yearTo}-12-31`);
  }

  const url = `${BASE_URL}?${params.toString()}`;
  const data = await fetchJSON<CourtListenerResponse>(url);

  const results = parseResults(data, maxResults);
  return {
    source: "CourtListener",
    results,
    totalCount: data?.count ?? 0,
    searchTimeMs: Date.now() - start,
  };
}

interface CourtListenerOpinion {
  id: number;
  snippet: string;
  download_url: string;
  type: string;
}

interface CourtListenerResult {
  absolute_url: string;
  caseName: string;
  caseNameFull: string;
  citation: string[];
  citeCount: number;
  cluster_id: number;
  court: string;
  court_id: string;
  dateFiled: string;
  docketNumber: string;
  judge: string;
  opinions: CourtListenerOpinion[];
  status: string;
}

interface CourtListenerResponse {
  count: number;
  next: string | null;
  results: CourtListenerResult[];
}

function parseResults(data: CourtListenerResponse, maxResults: number): PaperResult[] {
  const items = (data?.results ?? []).slice(0, maxResults);

  return items.map((item) => {
    // Parse year from dateFiled (YYYY-MM-DD)
    let year = 0;
    if (item.dateFiled) {
      const match = item.dateFiled.match(/^(\d{4})/);
      if (match) year = parseInt(match[1], 10);
    }

    // Build abstract from snippet + citations
    const abstractParts: string[] = [];
    if (item.judge) abstractParts.push("Judge: " + item.judge);
    if (item.citation && item.citation.length > 0) {
      abstractParts.push("Citations: " + item.citation.join("; "));
    }
    // Add snippet from first opinion (search-highlighted text)
    if (item.opinions?.[0]?.snippet) {
      // Strip HTML tags from snippet
      const snippet = item.opinions[0].snippet.replace(/<[^>]*>/g, "");
      abstractParts.push(snippet);
    }

    // Court display name
    const courtName = item.court || courtIdToName(item.court_id);

    // PDF URL from first opinion
    const pdfUrl = item.opinions?.[0]?.download_url || undefined;

    // Full URL on CourtListener
    const fullUrl = item.absolute_url
      ? `https://www.courtlistener.com${item.absolute_url}`
      : undefined;

    return {
      id: `courtlistener:${item.cluster_id}`,
      title: item.caseName || item.caseNameFull || "",
      authors: [{ name: courtName }],
      year,
      journal: courtName,
      abstract: abstractParts.join("\n") || undefined,
      citationCount: item.citeCount ?? 0,
      isOpenAccess: true,
      pdfUrl,
      sources: ["CourtListener"],
      // Legal fields
      itemType: "case",
      caseNumber: item.docketNumber ?? undefined,
      court: courtName,
      url: fullUrl,
    } as PaperResult;
  });
}

/** Map common court_id values to readable names */
function courtIdToName(courtId: string): string {
  const map: Record<string, string> = {
    scotus: "Supreme Court of the United States",
    ca1: "First Circuit", ca2: "Second Circuit", ca3: "Third Circuit",
    ca4: "Fourth Circuit", ca5: "Fifth Circuit", ca6: "Sixth Circuit",
    ca7: "Seventh Circuit", ca8: "Eighth Circuit", ca9: "Ninth Circuit",
    ca10: "Tenth Circuit", ca11: "Eleventh Circuit", cadc: "D.C. Circuit",
    cafc: "Federal Circuit",
  };
  return map[courtId] || courtId || "US Court";
}
