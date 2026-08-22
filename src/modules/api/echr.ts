import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse } from "./types";

const HUDOC_URL = "https://hudoc.echr.coe.int/app/query/results";

const SELECT_FIELDS = [
  "itemid", "docname", "appno", "ecli", "kpdate", "respondent",
  "article", "conclusion", "importance", "judgementdate",
  "documentcollectionid2", "languageisocode",
].join(",");

export async function searchECHR(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const maxResults = Math.min(options.maxResults ?? 20, 100);

  // Build HUDOC query
  const queryParts: string[] = ["documentcollectionid2:CASELAW"];

  // Prefer English results
  queryParts.push("languageisocode:ENG");

  // Add search terms (quoted for phrase search)
  const terms = options.query.trim();
  if (terms) {
    queryParts.push(`"${terms}"`);
  }

  const query = queryParts.join(" AND ");

  const params = new URLSearchParams({
    query,
    select: SELECT_FIELDS,
    sort: "kpdate Descending",
    start: "0",
    length: String(maxResults),
  });

  const url = `${HUDOC_URL}?${params.toString()}`;
  const data = await fetchJSON<HUDOCResponse>(url);

  let results = parseHUDOCResults(data);

  // Client-side year filtering
  if (options.yearFrom) {
    results = results.filter(r => r.year >= options.yearFrom!);
  }
  if (options.yearTo) {
    results = results.filter(r => r.year <= options.yearTo!);
  }

  return {
    source: "ECHR",
    results,
    totalCount: data?.resultcount ?? 0,
    searchTimeMs: Date.now() - start,
  };
}

interface HUDOCResponse {
  resultcount: number;
  results: Array<{ columns: Record<string, string> }>;
  message: string | null;
}

function parseHUDOCResults(data: HUDOCResponse): PaperResult[] {
  const items = data?.results ?? [];
  return items.map((item) => {
    const col = item.columns ?? {};

    // Parse year from kpdate (ISO datetime like "2026-04-09T00:00:00")
    let year = 0;
    if (col.kpdate) {
      const match = col.kpdate.match(/^(\d{4})/);
      if (match) year = parseInt(match[1], 10);
    }

    // Build abstract from articles + conclusion
    const abstractParts: string[] = [];
    if (col.article) {
      abstractParts.push("Convention Articles: " + col.article.replace(/;/g, ", "));
    }
    if (col.conclusion) {
      abstractParts.push(col.conclusion);
    }

    // Respondent state
    const respondent = col.respondent ?? "";
    const journal = respondent ? `ECHR \u2022 ${respondent}` : "ECHR";

    // Importance level (1 = key case, 4 = committee)
    const importance = parseInt(col.importance ?? "3", 10);

    return {
      id: `echr:${col.itemid}`,
      title: col.docname ?? "",
      authors: [{ name: "European Court of Human Rights" }],
      year,
      journal,
      abstract: abstractParts.join("\n") || undefined,
      citationCount: importance <= 2 ? 100 : 0, // Boost key cases in ranking
      isOpenAccess: true,
      sources: ["ECHR"],
      // Legal fields
      itemType: "case",
      caseNumber: col.appno ?? undefined,
      court: "European Court of Human Rights",
      ecli: col.ecli ?? undefined,
      url: col.itemid ? `https://hudoc.echr.coe.int/eng?i=${col.itemid}` : undefined,
    } as PaperResult;
  });
}
