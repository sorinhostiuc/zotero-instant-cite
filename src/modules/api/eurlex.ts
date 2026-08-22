import type { PaperResult, SearchOptions, SearchResponse } from "./types";

const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const USER_AGENT = "ZoteroInstantCite/0.4 (mailto:sorin.hostiuc@umfcd.ro)";

export async function searchEurLex(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const maxResults = Math.min(options.maxResults ?? 20, 30); // Keep low for SPARQL performance

  const searchTerms = options.query.trim().toLowerCase();
  if (!searchTerms) {
    return { source: "EUR-Lex", results: [], totalCount: 0, searchTimeMs: 0 };
  }

  // Build SPARQL query — single-graph title search (fast, avoids cross-graph joins)
  const sparql = buildSparqlQuery(searchTerms, maxResults);
  const body = "query=" + encodeURIComponent(sparql);

  const text = await sparqlPost(body);
  let data: SPARQLResponse;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("EUR-Lex: invalid SPARQL response");
  }

  let results = parseSPARQLResults(data);

  // Client-side year filtering
  if (options.yearFrom) {
    results = results.filter(r => r.year >= options.yearFrom!);
  }
  if (options.yearTo) {
    results = results.filter(r => r.year <= options.yearTo!);
  }

  return {
    source: "EUR-Lex",
    results,
    totalCount: results.length,
    searchTimeMs: Date.now() - start,
  };
}

function buildSparqlQuery(searchTerms: string, limit: number): string {
  const escaped = escapeSparql(searchTerms);

  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?expr ?title ?work WHERE {
  GRAPH ?g {
    ?expr cdm:expression_title ?title .
    FILTER(lang(?title) = 'en')
    FILTER(CONTAINS(LCASE(str(?title)), '${escaped}'))
    ?expr cdm:expression_belongs_to_work ?work .
  }
}
LIMIT ${limit}`;
}

interface SPARQLResponse {
  results: {
    bindings: Array<{
      expr?: { value: string };
      title?: { value: string };
      work?: { value: string };
    }>;
  };
}

function parseSPARQLResults(data: SPARQLResponse): PaperResult[] {
  const bindings = data?.results?.bindings ?? [];
  const seen = new Set<string>(); // Deduplicate by work URI

  return bindings
    .filter(b => {
      const workUri = b.work?.value ?? "";
      if (seen.has(workUri)) return false;
      seen.add(workUri);
      return true;
    })
    .map((b, idx) => {
      const rawTitle = b.title?.value ?? "";
      const workUri = b.work?.value ?? "";

      // Extract CELLAR ID from work URI
      const cellarId = workUri.replace(
        "http://publications.europa.eu/resource/cellar/", "",
      );
      const eurLexUrl = cellarId
        ? `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELLAR:${cellarId}`
        : undefined;

      // Clean title — EUR-Lex titles use # as section separators
      const title = cleanTitle(rawTitle);

      // Extract year from title (EU legislation titles often include dates)
      const year = extractYear(rawTitle);

      // Detect document type from title
      const docType = detectDocType(rawTitle);

      return {
        id: `eurlex:${cellarId || idx}`,
        title,
        authors: [{ name: docType.institution }],
        year,
        journal: docType.label,
        abstract: rawTitle.length > title.length ? rawTitle : undefined,
        citationCount: 0,
        isOpenAccess: true,
        sources: ["EUR-Lex"],
        itemType: "statute",
        url: eurLexUrl,
      } as PaperResult;
    });
}

function cleanTitle(raw: string): string {
  // EUR-Lex titles use # as separator for multi-part titles (especially CJEU cases)
  const parts = raw.split("#").map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return raw.trim();

  // For court cases: "Order of the Court...#Case name.#Details..."
  // Use first two parts joined with " — "
  if (parts.length >= 2) {
    return parts.slice(0, 2).join(" \u2014 ");
  }
  return parts[0];
}

function extractYear(title: string): number {
  // Match 4-digit years (1950-2099)
  const matches = title.match(/\b(19[5-9]\d|20\d{2})\b/g);
  if (matches && matches.length > 0) {
    // Use the last year found (usually the document's own year)
    return parseInt(matches[matches.length - 1], 10);
  }
  return 0;
}

interface DocTypeInfo {
  label: string;
  institution: string;
}

function detectDocType(title: string): DocTypeInfo {
  const lower = title.toLowerCase();

  if (lower.includes("regulation")) {
    return { label: "EU Regulation", institution: "European Parliament and Council" };
  }
  if (lower.includes("directive")) {
    return { label: "EU Directive", institution: "European Parliament and Council" };
  }
  if (lower.includes("decision")) {
    return { label: "EU Decision", institution: "European Commission" };
  }
  if (lower.includes("judgment") || lower.includes("order of the court")
    || lower.includes("order of the general")) {
    return { label: "CJEU Case Law", institution: "Court of Justice of the EU" };
  }
  if (lower.includes("opinion of advocate")) {
    return { label: "AG Opinion", institution: "Court of Justice of the EU" };
  }
  if (lower.includes("recommendation")) {
    return { label: "EU Recommendation", institution: "European Commission" };
  }

  return { label: "EUR-Lex", institution: "European Union" };
}

/** Escape special characters for SPARQL string literals */
function escapeSparql(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** POST to SPARQL endpoint with fallback for test environment */
async function sparqlPost(body: string): Promise<string> {
  if (typeof Zotero !== "undefined" && Zotero.HTTP?.request) {
    const resp = await Zotero.HTTP.request("POST", SPARQL_ENDPOINT, {
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      responseType: "text",
      timeout: 15000,
    });
    if (resp.status >= 200 && resp.status < 300) {
      return resp.responseText;
    }
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  // Fallback: XMLHttpRequest (test environment)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", SPARQL_ENDPOINT, true);
    xhr.timeout = 15000;
    xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    xhr.setRequestHeader("Accept", "application/sparql-results+json");
    try { xhr.setRequestHeader("User-Agent", USER_AGENT); } catch { /* forbidden in some contexts */ }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.ontimeout = () => reject(new Error("Request timeout"));
    xhr.send(body);
  });
}
