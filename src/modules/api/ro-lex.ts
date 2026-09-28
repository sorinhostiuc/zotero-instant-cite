import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse } from "./types";

/**
 * RO-Lex — Romanian legislation and case law, searched through the LegisRO
 * backend at legis.medleg.ro (`GET /api/search?q=...`). Covers laws (LEGE),
 * ordinances (OUG/OG), government decisions (HG), ministerial orders (ORDIN),
 * regulations, and Constitutional/Supreme Court decisions.
 */
const BASE_URL = "https://legis.medleg.ro";

interface RoLexHit {
  source?: string;
  source_id?: string;
  doc_type?: string;
  title?: string;
  official_reference?: string | null;
  status?: string | null;
  date_published?: string | null;
  snippet?: string | null;
  url_source?: string | null;
  title_lang?: string | null;
}

interface RoLexResponse {
  total?: number;
  hits?: RoLexHit[];
}

export async function searchRoLex(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const query = options.query.trim();
  if (!query) {
    return { source: "RO-Lex", results: [], totalCount: 0, searchTimeMs: 0 };
  }

  const perPage = Math.min(options.maxResults ?? 20, 30);
  const url = `${BASE_URL}/api/search?q=${encodeURIComponent(query)}&per_page=${perPage}`;
  const data = await fetchJSON<RoLexResponse>(url);

  return {
    source: "RO-Lex",
    results: parseRoLexResults(data, options),
    totalCount: data?.total ?? 0,
    searchTimeMs: Date.now() - start,
  };
}

/** Pure mapper — exported for testing without a network round-trip. */
export function parseRoLexResults(data: RoLexResponse, options: SearchOptions = { query: "" }): PaperResult[] {
  let results = (data?.hits ?? []).map(hitToPaperResult);

  // Client-side year filtering. Documents with an unknown year (0) are kept —
  // a null publication date shouldn't hide an otherwise-matching act.
  if (options.yearFrom) {
    results = results.filter(r => !r.year || r.year >= options.yearFrom!);
  }
  if (options.yearTo) {
    results = results.filter(r => !r.year || r.year <= options.yearTo!);
  }

  return results;
}

function hitToPaperResult(hit: RoLexHit, idx: number): PaperResult {
  const info = docTypeInfo(hit.doc_type ?? "");
  const year = extractYear(hit.date_published, hit.title);
  const url = resolveUrl(hit.url_source);
  const abstract = hit.snippet ? stripTags(hit.snippet) : undefined;

  const result: PaperResult = {
    id: `rolex:${hit.source_id || idx}`,
    title: hit.title?.trim() || "(fără titlu)",
    authors: info.institution ? [{ name: info.institution, isCorporate: true }] : [],
    year,
    journal: hit.official_reference?.trim() || info.label,
    abstract,
    isOpenAccess: true,
    sources: ["RO-Lex"],
    itemType: info.itemType,
    url,
  };
  if (info.court) result.court = info.court;
  return result;
}

interface DocTypeInfo {
  label: string;
  institution: string;
  itemType: string;
  court?: string;
}

function docTypeInfo(docType: string): DocTypeInfo {
  switch (docType.toUpperCase()) {
    case "LEGE":
      return { label: "Lege", institution: "Parlamentul României", itemType: "statute" };
    case "OUG":
      return { label: "Ordonanță de urgență", institution: "Guvernul României", itemType: "statute" };
    case "OG":
      return { label: "Ordonanță", institution: "Guvernul României", itemType: "statute" };
    case "HG":
    case "HOTARARE":
      return { label: "Hotărâre de Guvern", institution: "Guvernul României", itemType: "statute" };
    case "ORDIN":
      return { label: "Ordin", institution: "Ministru", itemType: "statute" };
    case "REGULAMENT":
      return { label: "Regulament", institution: "", itemType: "statute" };
    case "NORMA":
    case "NORME":
      return { label: "Normă", institution: "", itemType: "statute" };
    case "DECRET":
      return { label: "Decret", institution: "Președintele României", itemType: "statute" };
    case "ANEXA":
      return { label: "Anexă", institution: "", itemType: "statute" };
    case "DECIZIE_CCR":
      return {
        label: "Decizie CCR",
        institution: "Curtea Constituțională a României",
        itemType: "case",
        court: "Curtea Constituțională a României",
      };
    case "DECIZIE_ICCJ":
      return {
        label: "Decizie ÎCCJ",
        institution: "Înalta Curte de Casație și Justiție",
        itemType: "case",
        court: "Înalta Curte de Casație și Justiție",
      };
    default:
      return { label: docType || "RO-Lex", institution: "România", itemType: "statute" };
  }
}

/**
 * Prefer the ISO publication date. Otherwise pull the year from the title — but
 * from the act's own "nr. 150/2022" number, not a later year that references an
 * amended act (taking the last match would return the wrong year).
 */
function extractYear(datePublished?: string | null, title?: string | null): number {
  const isoMatch = datePublished?.match(/^(\d{4})/);
  if (isoMatch) return parseInt(isoMatch[1], 10);

  if (title) {
    // "nr. 150/2022" / "94/2020" — the act's own number/year.
    const numberYear = title.match(/\b\d{1,4}\/((?:1[89]|20)\d{2})\b/);
    if (numberYear) return parseInt(numberYear[1], 10);

    // "din 22.10.2020" — a Romanian numeric date.
    const dmy = title.match(/\b\d{1,2}[.\/]\d{1,2}[.\/]((?:1[89]|20)\d{2})\b/);
    if (dmy) return parseInt(dmy[1], 10);

    // Otherwise the first standalone 4-digit year.
    const first = title.match(/\b(1[89]\d{2}|20\d{2})\b/);
    if (first) return parseInt(first[1], 10);
  }
  return 0;
}

function resolveUrl(urlSource?: string | null): string | undefined {
  if (!urlSource) return undefined;
  return /^https?:\/\//.test(urlSource) ? urlSource : BASE_URL + urlSource;
}

/** Strip the <b> highlight markup the API wraps around matched terms. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
