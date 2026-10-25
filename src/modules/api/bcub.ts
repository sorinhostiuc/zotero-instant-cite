import type { Author, PaperResult, SearchOptions, SearchResponse } from "./types";

/**
 * BCUB — the catalogue of Biblioteca Centrală Universitară "Carol I" București
 * (catalog.bcub.ro, Softlink Liberty OPAC). Covers Romanian books, theses and
 * analytically indexed journal articles that no other source here holds.
 *
 * Liberty has no search API: the result page loads its records through DWR
 * (Direct Web Remoting) calls bound to the server-side search session.
 *  1. GET search.do runs the search and sets the JSESSIONID cookie.
 *  2. __System.generateId returns a DWR session id; DWR rejects later calls
 *     with "CSRF Security Error" unless it also comes back as the
 *     DWRSESSIONID cookie (the page's own script sets it via document.cookie).
 *  3. OpacSearchResult.navigateList returns the first page of record ids.
 *  4. OpacSearchResult.getHoverDetail, batched into one request, returns each
 *     record's detail HTML, which parseBcubRecord maps to a PaperResult.
 */
const BASE_URL = "https://catalog.bcub.ro/liberty";
const CORPORATION = "RO_BCUB";
const SOURCE = "BCUB";
const USER_AGENT = "ZoteroInstantCite/0.4 (mailto:sorin.hostiuc@umfcd.ro)";
const PAGE_SIZE = 10;

export async function searchBCUB(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const query = options.query.trim();
  if (!query) {
    return { source: SOURCE, results: [], totalCount: 0, searchTimeMs: 0 };
  }

  // Keep the Liberty session out of the user's cookie jar where Zotero can
  // isolate it (Zotero 8+); older versions share the default jar, which only
  // means the BCUB cookies stay around.
  const cookieContext = (Zotero.HTTP as any).newCookieContext?.() as { id: number; dispose(): void } | undefined;
  const session: BcubSession = { userContextId: cookieContext?.id };
  try {
    const page = await bcubRequest(session, "GET", searchUrl(query));
    const totalCount = parseTotalCount(page);
    if (totalCount === 0) {
      return { source: SOURCE, results: [], totalCount: 0, searchTimeMs: Date.now() - start };
    }

    const generated = parseDwrReplies(await dwrCall(session, [["__System", "generateId", []]]));
    const dwrSessionId = generated.get(0);
    if (!dwrSessionId) throw new Error("BCUB: no DWR session id");
    session.dwrSessionId = dwrSessionId;

    const list = await dwrCall(session, [[
      "OpacSearchResult", "navigateList",
      ["boolean:false", "string:", "boolean:false", "boolean:false", "string:"],
    ]]);
    const uuids = parseRecordUuids(list).slice(0, Math.min(options.maxResults ?? PAGE_SIZE, PAGE_SIZE));
    if (uuids.length === 0) {
      return { source: SOURCE, results: [], totalCount, searchTimeMs: Date.now() - start };
    }

    const details = parseDwrReplies(await dwrCall(session, uuids.map(uuid => [
      "OpacSearchResult", "getHoverDetail",
      ["boolean:false", `string:${uuid}`, "string:", "string:", "boolean:false"],
    ] as DwrCall)));

    const records = uuids
      .map((uuid, i) => ({ uuid, html: details.get(i) ?? "" }))
      .filter(r => r.html);
    return {
      source: SOURCE,
      results: parseBcubResults(records, options),
      totalCount,
      searchTimeMs: Date.now() - start,
    };
  } finally {
    cookieContext?.dispose();
  }
}

interface BcubSession {
  userContextId?: number;
  dwrSessionId?: string;
}

type DwrCall = [script: string, method: string, params: string[]];

function searchUrl(query: string): string {
  return `${BASE_URL}/opac/search.do?action=search&mode=BASIC&queryTerm=${encodeURIComponent(query)}`
    + `&openSearch=t&corporation=${CORPORATION}`;
}

/** Link to the record itself: a search on its id finds exactly that record. */
export function recordUrl(uuid: string): string {
  return searchUrl(`uuid="${uuid}"`);
}

/** Build a DWR plaincall body; several calls go in one "Multiple.N" batch. */
export function buildDwrBody(calls: DwrCall[], scriptSessionId: string): string {
  const lines = [`callCount=${calls.length}`, "nextReverseAjaxIndex=0"];
  calls.forEach(([script, method, params], i) => {
    lines.push(`c${i}-scriptName=${script}`, `c${i}-methodName=${method}`, `c${i}-id=${i}`);
    params.forEach((p, j) => lines.push(`c${i}-param${j}=${p}`));
  });
  lines.push(
    "batchId=0", "instanceId=0", "page=%2Fliberty%2Fopac%2Fsearch.do",
    `scriptSessionId=${scriptSessionId}`, "windowName=",
  );
  return lines.join("\n") + "\n";
}

async function dwrCall(session: BcubSession, calls: DwrCall[]): Promise<string> {
  const name = calls.length === 1 ? `${calls[0][0]}.${calls[0][1]}` : `Multiple.${calls.length}`;
  // The page script appends a random page id to the DWR session id.
  const scriptSessionId = session.dwrSessionId
    ? `${session.dwrSessionId}/${Math.random().toString(36).slice(2, 12)}`
    : "";
  return bcubRequest(session, "POST", `${BASE_URL}/dwr/call/plaincall/${name}.dwr`, buildDwrBody(calls, scriptSessionId));
}

async function bcubRequest(session: BcubSession, method: "GET" | "POST", url: string, body?: string): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (body !== undefined) headers["Content-Type"] = "text/plain";
  // Zotero sends this alongside the JSESSIONID cookie it keeps from step 1.
  if (session.dwrSessionId) headers.Cookie = `DWRSESSIONID=${session.dwrSessionId}`;
  const resp = await Zotero.HTTP.request(method, url, {
    body,
    headers,
    responseType: "text",
    timeout: getTimeout(),
    // No automatic 429/5xx retries (see base-client.ts httpGet).
    errorDelayMax: 0,
    noRetryOnThrottle: true,
    ...(session.userContextId ? { userContextId: session.userContextId } : {}),
  } as any);
  if (resp.status >= 200 && resp.status < 300) return resp.responseText;
  throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
}

function getTimeout(): number {
  try {
    const secs = Zotero.Prefs.get("InstantCite.searchTimeout");
    if (typeof secs === "number" && secs >= 1 && secs <= 30) return secs * 1000;
  } catch { /* ignore */ }
  return 15000;
}

/** "1-10 din 43" in the search page's navigation message. */
export function parseTotalCount(html: string): number {
  const m = html.match(/id="navigationMessage"[^>]*>\s*\d+\s*-\s*\d+\s+\S+\s+(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Map each DWR callback id to its decoded string result. */
export function parseDwrReplies(reply: string): Map<number, string> {
  const results = new Map<number, string>();
  const re = /handleCallback\("\d+","(\d+)",("(?:[^"\\]|\\.)*")\)/g;
  for (const m of reply.matchAll(re)) {
    results.set(parseInt(m[1], 10), decodeJsString(m[2]));
  }
  return results;
}

/** Record ids from navigateList, in result order and without duplicates. */
export function parseRecordUuids(reply: string): string[] {
  const seen = new Set<string>();
  for (const m of reply.matchAll(/visibleIndexes\\?"\s+value=\\?"([0-9a-f]{32})/g)) seen.add(m[1]);
  return [...seen];
}

/** Decode a double-quoted JavaScript string literal as DWR writes it. */
export function decodeJsString(literal: string): string {
  return literal.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc: string) => {
    if (esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      default: return esc;
    }
  });
}

export function parseBcubResults(
  records: Array<{ uuid: string; html: string }>,
  options: SearchOptions = { query: "" },
): PaperResult[] {
  let results = records
    .map(r => parseBcubRecord(r.uuid, r.html))
    .filter((r): r is PaperResult => r !== null);

  // Records without a year (0) are kept, as for RO-Lex.
  if (options.yearFrom) results = results.filter(r => !r.year || r.year >= options.yearFrom!);
  if (options.yearTo) results = results.filter(r => !r.year || r.year <= options.yearTo!);
  return results;
}

/** Map one getHoverDetail HTML to a PaperResult; serials themselves are skipped. */
export function parseBcubRecord(uuid: string, html: string): PaperResult | null {
  const bibType = html.match(/title="([^"]+)" class="bibtypeImg"/)?.[1] ?? "";
  if (bibType === "Serial") return null;
  const title = cleanText(html.match(/class="catalogTitle"[\s\S]*?<strong>([\s\S]*?)<\/strong>/)?.[1] ?? "");
  if (!title) return null;

  const fields = parseFields(html);
  const itemType = bibType === "Articol" ? "journalArticle" : bibType === "Teză" ? "thesis" : "book";
  const publication = parsePublication(fields.get("Date de publicare"));
  const parent = parseParentDescription(fields.get("Descriere părinte"));

  const result: PaperResult = {
    id: `bcub:${uuid}`,
    title,
    authors: parseCreators(fields.get("Autori"), fields.get("Autori colectivi"), itemType),
    year: publication.year || parent.year,
    isOpenAccess: false,
    sources: [SOURCE],
    itemType,
    url: recordUrl(uuid),
  };
  if (itemType === "journalArticle") {
    const journal = parseParentTitle(fields.get("Titlu părinte"));
    if (journal) result.journal = journal;
    if (parent.volume) result.volume = parent.volume;
    if (parent.issue) result.issue = parent.issue;
    if (parent.pages) result.pages = parent.pages;
  } else {
    if (publication.publisher) result.publisher = publication.publisher;
    if (publication.place) result.place = publication.place;
  }
  const isbn = cleanText(fields.get("ISBN") ?? "").match(/\b(97[89][\d-]{10,14}|[\d-]{9,12}[\dXx])\b/)?.[1];
  if (isbn && itemType === "book") result.isbn = isbn.replace(/-/g, "");
  return result;
}

/** Label -> raw value HTML for each row of the detail table. */
function parseFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  const re = /<th[^>]*class="opac_label[^"]*"[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*class="opac_result opac_detail_field[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  for (const m of html.matchAll(re)) {
    const label = cleanText(m[1]).replace(/:$/, "");
    if (!fields.has(label)) fields.set(label, m[2]);
  }
  return fields;
}

const EDITOR_ROLES = /^(editor|coordonator(?! teză)|îngrijitor|ingrijitor|redactor)/i;

/**
 * "Kuglay, Irina [Autor] (10); Nemes, Marinela [Autor]": each name, then its
 * role in brackets and, when the catalogue holds more than one record for it, a
 * link and the record count. Authors come first, then editors, translators and
 * (for a thesis) the adviser as contributor.
 */
export function parseCreators(personal?: string, corporate?: string, itemType = "book"): Author[] {
  const authors: Author[] = [];
  const others: Author[] = [];
  const readLinks = (html: string | undefined, isCorporate: boolean) => {
    if (!html) return;
    for (const entry of cleanText(html).split(";")) {
      const m = entry.match(/^\s*(.*?)\s*(?:\[([^\]]*)\])?\s*(?:\(\d+\))?\s*$/);
      const name = (m?.[1] ?? "").replace(/\s+\d{3,4}-(?:\d{3,4})?$/, "").trim();
      if (!name) continue;
      const role = (m?.[2] ?? "").trim();
      const author: Author = isCorporate
        ? { name, lastName: name, isCorporate: true }
        : splitName(name);
      if (!role || /^autor/i.test(role)) {
        authors.push(author);
      } else if (EDITOR_ROLES.test(role)) {
        others.push({ ...author, creatorType: "editor" });
      } else if (/^coordonator teză/i.test(role) && itemType === "thesis") {
        others.push({ ...author, creatorType: "contributor" });
      } else if (/^traducător|^traducator/i.test(role)) {
        others.push({ ...author, creatorType: "translator" });
      }
    }
  };
  readLinks(personal, false);
  // A corporate body is listed as author mostly for serials and reports; use it
  // only when no person is named.
  if (authors.length === 0) readLinks(corporate, true);
  return [...authors, ...others];
}

function splitName(name: string): Author {
  const comma = name.indexOf(",");
  if (comma < 0) return { name, lastName: name };
  const lastName = name.slice(0, comma).trim();
  const firstName = name.slice(comma + 1).trim();
  return { name: firstName ? `${firstName} ${lastName}` : lastName, lastName, firstName };
}

/** "Bucuresti: Editura C. H. Beck (3652), 2021" */
export function parsePublication(html?: string): { place?: string; publisher?: string; year: number } {
  if (!html) return { year: 0 };
  const text = cleanText(html).replace(/\s*\(\d+\)/g, "");
  const year = parseInt(text.match(/\b(1[5-9]\d{2}|20\d{2})\b(?!.*\b(?:1[5-9]\d{2}|20\d{2})\b)/)?.[1] ?? "0", 10);
  const colon = text.indexOf(":");
  const place = colon > 0 ? text.slice(0, colon).trim() : undefined;
  const rest = (colon > 0 ? text.slice(colon + 1) : text).replace(/,?\s*\[?c?\d{4}\]?\s*$/, "").trim();
  const publisher = rest && !/^\d+$/.test(rest) ? rest.replace(/[,;]\s*$/, "") : undefined;
  return { place: place || undefined, publisher, year };
}

/** "Vol. 3, nr. 4/2005", "An 27, nr. 8/2016", "Nr. 8/2020, p. 12-20" */
export function parseParentDescription(html?: string): { volume?: string; issue?: string; pages?: string; year: number } {
  if (!html) return { year: 0 };
  const text = cleanText(html);
  const volume = text.match(/\b(?:vol|an|anul)\.?\s*([\w-]+)/i)?.[1];
  const issueMatch = text.match(/\bnr\.?\s*([\w-]+)(?:\s*\/\s*(\d{4}))?/i);
  const pages = text.match(/\bp\.?\s*(\d+(?:\s*-\s*\d+)?)/i)?.[1]?.replace(/\s+/g, "");
  const yearText = issueMatch?.[2] ?? text.match(/\b(1[89]\d{2}|20\d{2})\b/)?.[1];
  return { volume, issue: issueMatch?.[1], pages, year: yearText ? parseInt(yearText, 10) : 0 };
}

/** "REVISTA romana de bioetica : Roumanian Journal of Bioethics" -> "Revista romana de bioetica" */
export function parseParentTitle(html?: string): string | undefined {
  if (!html) return undefined;
  const title = cleanText(html).split(/\s+[:=/]\s+/)[0].trim();
  // Catalogues capitalise the filing word: "REVISTA romana" -> "Revista romana".
  return title.replace(/^(\p{Lu})(\p{Lu}+)(?=\s|$)/u, (_, first: string, rest: string) => first + rest.toLowerCase()) || undefined;
}

function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
