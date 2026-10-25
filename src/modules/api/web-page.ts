import type { Author, PaperResult, SearchResponse } from "./types";
import { normalizeDoi } from "../utils/doi";

/** A page listing several works (search results, a table of contents) yields at most this many. */
const MAX_PAGE_ITEMS = 10;
const PAGE_TIMEOUT_MS = 20000;

/**
 * Read the reference a web page describes, with the same translators the
 * Zotero Connector uses, but without saving anything: the items come back as
 * translator JSON and are only stored when the user adds or cites one.
 * Pages no translator recognises still give a "webpage" record built from
 * their title and meta tags.
 */
export async function translateWebPage(url: string): Promise<SearchResponse> {
  const start = Date.now();
  const { html, finalUrl, contentType } = await fetchPage(url);
  if (/application\/pdf/i.test(contentType)) {
    throw new Error("The link opens a PDF file, not a page with its details; paste the article page or its DOI");
  }

  const parsed = new DOMParser().parseFromString(html, "text/html");
  const doc = Zotero.HTTP.wrapDocument(parsed, finalUrl);

  let items: any[] = [];
  try {
    items = await runTranslators(doc);
  } catch (err) {
    Zotero.log("[InstantCite] Web translation failed for " + finalUrl + ": " + err);
  }
  if (items.length === 0) {
    if (isBotCheckPage(parsed, html)) {
      throw new Error("The site answered with a robot check instead of the page; paste the DOI or the title instead");
    }
    items = [webpageFromMeta(parsed, finalUrl)];
  }

  const results = items.slice(0, MAX_PAGE_ITEMS).map(item => paperFromTranslatorItem(item, finalUrl));
  return { source: "Web", results, totalCount: results.length, searchTimeMs: Date.now() - start };
}

async function fetchPage(url: string): Promise<{ html: string; finalUrl: string; contentType: string }> {
  // No custom User-Agent: many publishers refuse unknown agents, and Zotero's
  // own matches what the Connector sends.
  const resp = await Zotero.HTTP.request("GET", url, {
    timeout: PAGE_TIMEOUT_MS,
    responseType: "text",
    headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    successCodes: false,
    errorDelayMax: 0,
    noRetryOnThrottle: true,
  } as any);
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`The site refused the request (HTTP ${resp.status}); paste the DOI or the title instead`);
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HTTP ${resp.status} for the page`);
  }
  return {
    html: resp.responseText ?? "",
    finalUrl: resp.responseURL || url,
    contentType: resp.getResponseHeader?.("Content-Type") ?? "",
  };
}

async function runTranslators(doc: Document): Promise<any[]> {
  const translate = new Zotero.Translate.Web();
  translate.setDocument(doc);
  const translators = await translate.getTranslators();
  if (!translators?.length) return [];
  // Every matching translator, best first: when one fails Zotero moves on to
  // the next, ending with Embedded Metadata.
  translate.setTranslator(translators);
  // Multi-item pages ask which items to save; take the first ones and let
  // the result list do the choosing.
  translate.setHandler("select", (_t: unknown, items: Record<string, string>, callback: (s: Record<string, string>) => void) => {
    const chosen: Record<string, string> = {};
    for (const key of Object.keys(items).slice(0, MAX_PAGE_ITEMS)) chosen[key] = items[key];
    callback(chosen);
  });
  const items = await translate.translate({ libraryID: false, saveAttachments: false });
  return Array.isArray(items) ? items.filter(i => i && i.itemType && i.itemType !== "note" && i.itemType !== "attachment") : [];
}

/**
 * Anti-bot interstitials (Akamai, Cloudflare and the like) come back as
 * HTTP 200 with a script and a self-refresh instead of the page; recording
 * one would store the check, not the work.
 */
export function isBotCheckPage(doc: Document, html: string): boolean {
  const refresh = doc.querySelector('meta[http-equiv="refresh" i]')?.getAttribute("content") ?? "";
  if (/verify|challenge|captcha/i.test(refresh)) return true;
  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  if (/^(just a moment|attention required|access denied|checking your browser|please wait|one moment|verifying)/i.test(title)) {
    return true;
  }
  // A near-empty page with no title and no description has nothing to cite.
  return !title && !metaContent(doc, "og:title", "citation_title", "description") && html.length < 5000;
}

function metaContent(doc: Document, ...names: string[]): string {
  for (const name of names) {
    const el = doc.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`);
    const value = el?.getAttribute("content")?.trim();
    if (value) return value;
  }
  return "";
}

/** Fallback record for pages without a translator: title, site, author, date. */
export function webpageFromMeta(doc: Document, url: string): Record<string, any> {
  const title = metaContent(doc, "citation_title", "dc.title", "og:title", "twitter:title")
    || doc.querySelector("title")?.textContent?.trim()
    || url;
  const creators = doc.querySelectorAll('meta[name="citation_author" i]').length > 0
    ? Array.from(doc.querySelectorAll('meta[name="citation_author" i]'))
      .map(el => el.getAttribute("content")?.trim() ?? "")
    : metaContent(doc, "author", "dc.creator", "article:author").split(/\s*;\s*/);
  return {
    itemType: "webpage",
    title: title.replace(/\s+/g, " "),
    websiteTitle: metaContent(doc, "og:site_name", "application-name"),
    creators: creators.filter(Boolean).filter(n => !/^https?:/i.test(n)).map(splitName),
    date: metaContent(doc, "citation_publication_date", "citation_date", "dc.date",
      "article:published_time", "date", "datePublished").replace(/T.*$/, ""),
    abstractNote: metaContent(doc, "description", "og:description", "dc.description"),
    language: doc.documentElement?.getAttribute("lang") ?? "",
    url,
    accessDate: "CURRENT_TIMESTAMP",
  };
}

function splitName(name: string): Record<string, string> {
  if (name.includes(",")) {
    const [lastName, firstName] = name.split(/\s*,\s*/, 2);
    return { lastName, firstName, creatorType: "author" };
  }
  const parts = name.split(/\s+/);
  if (parts.length === 1) return { name, creatorType: "author" };
  return { lastName: parts.pop()!, firstName: parts.join(" "), creatorType: "author" };
}

/**
 * Translator JSON → the API JSON Item#fromJSON takes, as Zotero's own item
 * saver does it: no attachments or notes, single-field creators as `name`,
 * tags as objects, the access-date placeholder resolved.
 */
export function translatorItemForSaving(item: Record<string, any>, now = new Date()): Record<string, any> {
  const json: Record<string, any> = { ...item };
  for (const field of ["attachments", "notes", "seeAlso", "id", "itemID", "key", "version",
    "dateAdded", "dateModified", "path", "complete"]) {
    delete json[field];
  }
  json.creators = (item.creators ?? [])
    .filter((c: any) => c && (c.lastName || c.firstName || c.name))
    .map((c: any) => (c.name || c.fieldMode == 1)
      ? { name: String(c.name ?? c.lastName).trim(), creatorType: c.creatorType || "author" }
      : { firstName: String(c.firstName ?? "").trim(), lastName: String(c.lastName ?? "").trim(),
        creatorType: c.creatorType || "author" });
  json.tags = (item.tags ?? [])
    .map((t: any) => (typeof t === "string" ? { tag: t } : t))
    .filter((t: any) => t?.tag && String(t.tag).trim())
    .map((t: any) => ({ tag: String(t.tag).trim(), type: 1 }));
  if (json.accessDate === "CURRENT_TIMESTAMP" || (json.url && !json.accessDate)) {
    json.accessDate = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return json;
}

function doiFromExtra(extra: string | undefined): string {
  const m = (extra ?? "").match(/^DOI:\s*(\S+)/im);
  return m ? normalizeDoi(m[1]) : "";
}

/** Translator JSON → the record the result list shows; the JSON rides along for saving. */
export function paperFromTranslatorItem(item: Record<string, any>, pageUrl: string): PaperResult {
  const authors: Author[] = (item.creators ?? [])
    .filter((c: any) => c && (c.lastName || c.firstName || c.name))
    .map((c: any) => {
      if (c.name || c.fieldMode == 1) {
        const name = String(c.name ?? c.lastName).trim();
        return { name, lastName: name, isCorporate: true, creatorType: c.creatorType };
      }
      const firstName = String(c.firstName ?? "").trim();
      const lastName = String(c.lastName ?? "").trim();
      return { name: [firstName, lastName].filter(Boolean).join(" "), firstName, lastName, creatorType: c.creatorType };
    });
  const year = parseInt(String(item.date ?? "").match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1] ?? "0", 10);
  const doi = normalizeDoi(item.DOI) || doiFromExtra(item.extra);
  const pdf = (item.attachments ?? []).find((a: any) => /pdf/i.test(a?.mimeType ?? "") && a.url);
  const url = item.url || pageUrl;

  return {
    id: "web:" + (doi || url),
    title: String(item.title ?? url).trim(),
    authors,
    year,
    journal: item.publicationTitle || item.bookTitle || item.websiteTitle || item.blogTitle ||
      item.forumTitle || item.proceedingsTitle || item.university || undefined,
    journalAbbreviation: item.journalAbbreviation || undefined,
    issn: item.ISSN || undefined,
    volume: item.volume || undefined,
    issue: item.issue || undefined,
    pages: item.pages || undefined,
    publisher: item.publisher || undefined,
    place: item.place || undefined,
    doi: doi || undefined,
    isbn: item.ISBN ? String(item.ISBN).split(/\s+/)[0].replace(/-/g, "") : undefined,
    abstract: item.abstractNote || undefined,
    isOpenAccess: false,
    pdfUrl: pdf?.url,
    sources: ["Web"],
    itemType: item.itemType,
    url,
    zoteroJSON: item,
  };
}
