import { fetchJSON } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const BASE_URL = "https://www.loc.gov/books/";

/**
 * Library of Congress — public JSON catalog endpoint.
 * No key required, no documented rate limit (we still go easy: 50 results max).
 *
 * The MARCXML SRU endpoint is more authoritative but heavier to parse.
 * The /books/ JSON view returns clean records covering the same catalog.
 */
export async function searchLoC(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const maxResults = Math.min(options.maxResults ?? 20, 50);

  const params = new URLSearchParams({
    q: options.query,
    fo: "json",
    c: String(maxResults),
    at: "results,pagination",
  });

  // LoC accepts dates filter via faceting: dates:YYYY-YYYY
  if (options.yearFrom || options.yearTo) {
    const from = options.yearFrom ?? 1500;
    const to = options.yearTo ?? new Date().getFullYear();
    params.set("dates", `${from}/${to}`);
  }

  const url = `${BASE_URL}?${params.toString()}`;
  let data: any;
  try {
    data = await fetchJSON<any>(url);
  } catch (err) {
    if (isLoCBlocked(err)) {
      if (typeof Zotero !== "undefined") {
        Zotero.log("[InstantCite] LoC unavailable: " + String((err as any)?.message ?? err));
      }
      return {
        source: "LoC",
        results: [],
        totalCount: 0,
        searchTimeMs: Date.now() - start,
      };
    }
    throw err;
  }

  const records = data?.results ?? [];
  const totalCount = data?.pagination?.of ?? records.length;

  const results: PaperResult[] = [];
  for (const r of records) {
    // Skip non-book results (LoC sometimes mixes in other formats)
    if (Array.isArray(r.original_format) && r.original_format.length > 0) {
      const formats = r.original_format.map((f: string) => f.toLowerCase());
      if (!formats.some((f: string) => f.includes("book"))) continue;
    }

    const title = stripTrailingSlash(getString(r.title));
    if (!title) continue;

    const authors: Author[] = (r.contributor_names ?? r.contributor ?? [])
      .map((n: any) => ({ name: stripTrailingComma(getString(n)) }))
      .filter((a: Author) => a.name);

    const year = parseYear(r.date) || parseYear(r.dates?.[0]);

    // LoC IDs look like: "https://www.loc.gov/item/2020012345/"
    const id = getString(r.id) || getString(r.url);

    // ISBN — sometimes in `number_isbn`, sometimes nested in `item.isbns`
    let isbn: string | undefined;
    if (Array.isArray(r.number_isbn) && r.number_isbn.length > 0) {
      isbn = String(r.number_isbn[0]).replace(/[^0-9X]/gi, "") || undefined;
    } else if (Array.isArray(r.item?.isbns) && r.item.isbns.length > 0) {
      isbn = String(r.item.isbns[0]).replace(/[^0-9X]/gi, "") || undefined;
    }

    const abstract = Array.isArray(r.description) ? r.description.join(" ") : getString(r.description);

    results.push({
      id: `loc:${id}`,
      title,
      authors,
      year,
      journal: getString(r.publisher) || undefined,
      doi: undefined,
      isbn,
      abstract: abstract || undefined,
      isOpenAccess: false,
      url: getString(r.url) || id || undefined,
      itemType: "book",
      sources: ["LoC"],
    } as PaperResult);
  }

  return {
    source: "LoC",
    results,
    totalCount,
    searchTimeMs: Date.now() - start,
  };
}

function getString(v: any): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && v.length > 0) return getString(v[0]);
  return "";
}

function parseYear(dateStr: any): number {
  const s = getString(dateStr);
  const m = s.match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : 0;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\s*\/\s*$/, "").trim();
}

/** LoC catalog convention: contributor names often end with a comma + dates ("Smith, John, 1923-"). */
function stripTrailingComma(s: string): string {
  return s.replace(/,\s*\d{4}.*$/, "").replace(/,\s*$/, "").trim();
}

function isLoCBlocked(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  return /HTTP\s+403|Cloudflare|Just a moment|Enable JavaScript and cookies|cf_chl/i.test(msg);
}
