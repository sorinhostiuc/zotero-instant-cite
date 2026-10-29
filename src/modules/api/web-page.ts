import type { Author, PaperResult, SearchResponse } from "./types";
import { lookupCrossRefDOI } from "./crossref";
import { normalizeDoi } from "../utils/doi";

/** A page listing several works (search results, a table of contents) yields at most this many. */
const MAX_PAGE_ITEMS = 10;
const PAGE_TIMEOUT_MS = 20000;
/** How long the hidden browser may spend getting past a robot check. */
const BROWSER_WAIT_MS = 20000;
const BROWSER_POLL_MS = 1000;
/** Answers that mean "not for scripts", which a real browser often gets past. */
const BLOCKED_STATUS = new Set([0, 401, 403, 429, 503]);
const NO_PAGE_NOTICE = "The site would not show the page, so the record holds only what the link says; check the title before citing";

interface LoadedPage {
  html: string;
  finalUrl: string;
}

/**
 * Read the reference a web page describes, with the same translators the
 * Zotero Connector uses, but without saving anything: the items come back as
 * translator JSON and are only stored when the user adds or cites one.
 * Pages no translator recognises still give a "webpage" record built from
 * their meta tags and body (title, authors, date, site, access date).
 * Sites that refuse plain requests are opened in a hidden browser, which gets
 * past most robot checks; when even that fails the record comes from the link.
 */
export async function translateWebPage(url: string): Promise<SearchResponse> {
  const start = Date.now();
  const page = await fetchPage(url) ?? await loadInBrowser(url);
  if (!page) {
    const results = [paperFromTranslatorItem(webpageFromURL(url), url)];
    return { source: "Web", results, totalCount: 1, searchTimeMs: Date.now() - start, notice: NO_PAGE_NOTICE };
  }

  const parsed = new DOMParser().parseFromString(page.html, "text/html");
  const doc = Zotero.HTTP.wrapDocument(parsed, page.finalUrl);

  let translated: Translated = { items: [], generic: false };
  try {
    translated = await runTranslators(doc);
  } catch (err) {
    Zotero.log("[InstantCite] Web translation failed for " + page.finalUrl + ": " + err);
  }
  let items = translated.items;
  const fromPage = webpageFromMeta(parsed, page.finalUrl);
  if (items.length === 0) items = [fromPage];
  else if (items.length === 1) {
    // The generic translator misses tags written as property= (ResearchGate
    // does that) and then falls back to the page's own title and date.
    if (translated.generic) applyCitationTags(items[0], citationTags(parsed));
    fillThinItem(items[0], fromPage);
  }
  for (const item of items) item.title = stripFileLabel(clean(item.title));

  if (translated.generic && items.length === 1) {
    const canonical = await canonicalRecord(items[0]);
    if (canonical) {
      return { source: "Web", results: [canonical], totalCount: 1, searchTimeMs: Date.now() - start };
    }
  }
  const results = items.slice(0, MAX_PAGE_ITEMS).map(item => paperFromTranslatorItem(item, page.finalUrl));
  return { source: "Web", results, totalCount: results.length, searchTimeMs: Date.now() - start };
}

/**
 * A record read by the generic translator from a page that names the work's
 * DOI (a repository or a social site showing someone else's article) is only
 * as good as that page; the DOI's own registration is the reference.
 */
async function canonicalRecord(item: Record<string, any>): Promise<PaperResult | undefined> {
  const doi = normalizeDoi(item.DOI) || doiFromExtra(item.extra);
  if (!doi) return undefined;
  try {
    return (await lookupCrossRefDOI(doi)).results[0];
  } catch (err) {
    Zotero.log("[InstantCite] CrossRef lookup for the page's DOI failed: " + err);
    return undefined;
  }
}

/**
 * The page by a plain request, or null when the site turned the request away
 * (401/403/429/503 or a robot-check page) and a browser should try instead.
 */
async function fetchPage(url: string): Promise<LoadedPage | null> {
  // No custom User-Agent: many publishers refuse unknown agents, and Zotero's
  // own matches what the Connector sends.
  let resp: any;
  try {
    resp = await Zotero.HTTP.request("GET", url, {
      timeout: PAGE_TIMEOUT_MS,
      responseType: "text",
      headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
      successCodes: false,
      errorDelayMax: 0,
      noRetryOnThrottle: true,
    } as any);
  } catch (err) {
    Zotero.log("[InstantCite] Page request failed for " + url + ": " + err);
    return null;
  }
  if (/application\/pdf/i.test(resp.getResponseHeader?.("Content-Type") ?? "")) {
    throw new Error("The link opens a PDF file, not a page with its details; paste the article page or its DOI");
  }
  if (BLOCKED_STATUS.has(resp.status)) return null;
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HTTP ${resp.status} for the page`);
  }
  const html = resp.responseText ?? "";
  if (isBotCheckPage(new DOMParser().parseFromString(html, "text/html"), html)) return null;
  return { html, finalUrl: resp.responseURL || url };
}

/**
 * Open the page in Zotero's hidden browser (a real Gecko page that runs the
 * site's scripts, as the Connector's own snapshot does) and wait until the
 * robot check, if any, gives way to the page. Null when it never does.
 */
async function loadInBrowser(url: string): Promise<LoadedPage | null> {
  let browser: any;
  try {
    const { HiddenBrowser } = ChromeUtils.importESModule("chrome://zotero/content/HiddenBrowser.mjs") as any;
    // No separate cookie context: with userContextId the browser never gets a
    // browsing context and load() fails.
    browser = new HiddenBrowser({});
    await browser._createdPromise;
    try {
      await browser.load(url);
    } catch (err) {
      // load() gives up after a few seconds on slow pages and challenge
      // redirects; the page keeps loading, so carry on polling.
      Zotero.log("[InstantCite] Hidden browser load for " + url + ": " + err);
    }
    const deadline = Date.now() + BROWSER_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const data = await browser.getPageData(["channelInfo", "documentHTML"], { timeout: 5000 });
        const status = data.channelInfo?.responseStatus ?? 0;
        const html: string = data.documentHTML ?? "";
        if (status >= 400 && !BLOCKED_STATUS.has(status)) return null;
        if (status >= 200 && status < 300 && html
          && !isBotCheckPage(new DOMParser().parseFromString(html, "text/html"), html)) {
          return { html, finalUrl: browser.currentURI?.spec || url };
        }
      } catch {
        // The challenge navigates away while the page is being read; ask again.
      }
      await new Promise(resolve => setTimeout(resolve, BROWSER_POLL_MS));
    }
    Zotero.log("[InstantCite] Hidden browser never got past the robot check for " + url);
    return null;
  } catch (err) {
    Zotero.log("[InstantCite] Hidden browser failed for " + url + ": " + err);
    return null;
  } finally {
    try {
      browser?.destroy();
    } catch {
      // already gone
    }
  }
}

/** Zotero's generic translator for citation_*, Dublin Core, Open Graph and JSON-LD tags. */
const EMBEDDED_METADATA = "951c027d-74ac-47d4-a107-9c3069ab7b48";

interface Translated {
  items: any[];
  /** Read by the generic translator rather than one written for the site */
  generic: boolean;
}

async function runTranslators(doc: Document): Promise<Translated> {
  const translators = await withDocument(doc).getTranslators();
  if (translators?.length) {
    try {
      // Every matching translator, best first: when one fails Zotero moves on to the next.
      const items = await translateWith(doc, translators);
      if (items.length > 0) return { items, generic: translators[0].translatorID === EMBEDDED_METADATA };
    } catch (err) {
      Zotero.log("[InstantCite] Site translator failed: " + err);
    }
  }
  // Site translators often download an export file the site refuses to
  // scripts (Wiley answers 403), and a matching site translator keeps the
  // generic one out of the list; the tags in the page still describe the work.
  if (translators?.some((t: any) => t.translatorID === EMBEDDED_METADATA)) return { items: [], generic: true };
  return { items: await translateWith(doc, EMBEDDED_METADATA), generic: true };
}

function withDocument(doc: Document): any {
  const translate = new Zotero.Translate.Web();
  translate.setDocument(doc);
  return translate;
}

async function translateWith(doc: Document, translators: any): Promise<any[]> {
  const translate = withDocument(doc);
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

/** Markers only robot-check pages carry; normal pages never include them. */
const BOT_CHECK_MARKERS = /_cf_chl_opt|cf-chl-widget|id="challenge-(?:form|stage|running)"|captcha-delivery\.com|id="px-captcha"|bm-verify/i;

/**
 * Anti-bot interstitials (Akamai, Cloudflare and the like) come back as
 * HTTP 200 with a script and a self-refresh instead of the page; recording
 * one would store the check, not the work. Their titles are translated into
 * the browser's language, so the markup is checked as well as the title.
 */
export function isBotCheckPage(doc: Document, html: string): boolean {
  const refresh = doc.querySelector('meta[http-equiv="refresh" i]')?.getAttribute("content") ?? "";
  if (/verify|challenge|captcha/i.test(refresh)) return true;
  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  if (/^(just a moment|attention required|access denied|checking your browser|please wait|one moment|verifying)/i.test(title)) {
    return true;
  }
  const hasMeta = Boolean(metaContent(doc, "og:title", "citation_title", "description"));
  if (!hasMeta && BOT_CHECK_MARKERS.test(html)) return true;
  // A near-empty page with no title and no description has nothing to cite.
  return !title && !hasMeta && html.length < 5000;
}

function metaContent(doc: Document, ...names: string[]): string {
  for (const name of names) {
    const el = doc.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`);
    const value = el?.getAttribute("content")?.trim();
    if (value) return value;
  }
  return "";
}

function clean(text: string | null | undefined): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** schema.org types that describe the work on the page, best first. */
const WORK_TYPES = ["ScholarlyArticle", "MedicalScholarlyArticle", "NewsArticle", "ReportageNewsArticle",
  "AnalysisNewsArticle", "OpinionNewsArticle", "BlogPosting", "SocialMediaPosting", "TechArticle", "Report",
  "Article", "Legislation", "Book", "Chapter", "Thesis", "CreativeWork", "MedicalWebPage", "WebPage"];

/** The JSON-LD object describing the page's work, from every script block and @graph. */
export function jsonLdWork(doc: Document): Record<string, any> | undefined {
  const found: Record<string, any>[] = [];
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    if (Array.isArray(node)) {
      node.forEach(n => visit(n, depth + 1));
      return;
    }
    if (node["@type"]) found.push(node);
    if (node["@graph"]) visit(node["@graph"], depth + 1);
    if (node.mainEntity) visit(node.mainEntity, depth + 1);
  };
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json" i]'))) {
    try {
      visit(JSON.parse(script.textContent ?? ""), 0);
    } catch {
      // Broken JSON-LD is common; the other sources still count.
    }
  }
  const rank = (node: Record<string, any>) => {
    const types = ([] as string[]).concat(node["@type"]).map(String);
    const ranks = types.map(t => WORK_TYPES.indexOf(t)).filter(i => i >= 0);
    return ranks.length ? Math.min(...ranks) : -1;
  };
  return found
    .filter(node => rank(node) >= 0)
    .sort((a, b) => rank(a) - rank(b))[0];
}

function ldText(value: any): string {
  if (Array.isArray(value)) return ldText(value[0]);
  if (value && typeof value === "object") return clean(value.name ?? value["@value"] ?? "");
  return clean(value);
}

/** Authors from a JSON-LD author/creator value: text, Person, Organization or a list of them. */
function ldCreators(value: any): Record<string, string>[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const creators: Record<string, string>[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      creators.push(...splitAuthorText(entry).map(splitName));
    } else if (entry && typeof entry === "object") {
      const types = ([] as string[]).concat(entry["@type"] ?? []).map(String);
      if (entry.familyName) {
        creators.push({ lastName: clean(entry.familyName), firstName: clean(entry.givenName), creatorType: "author" });
      } else if (entry.name) {
        const name = ldText(entry.name);
        if (types.includes("Organization")) creators.push({ name, creatorType: "author" });
        else if (name) creators.push(splitName(name));
      }
    }
  }
  return creators;
}

/** Byline text ("By Jane Doe and John Smith") → separate names. */
function splitAuthorText(text: string): string[] {
  // Lower-case "de" only: "De Luca" is a surname, "de Ion Popescu" a Romanian byline.
  const stripped = clean(text).replace(/^(?:by|autor(?:i|ul)?|authors?)\s*:?\s+/i, "").replace(/^de\s+/, "");
  let parts = stripped.split(/\s*;\s*|\s*\|\s*|\s+(?:and|și|si|&)\s+/i);
  // "Doe, Jane" is one name; "Jane Doe, John Smith" are two.
  if (parts.length === 1 && stripped.includes(",")) {
    const commaParts = stripped.split(/\s*,\s*/);
    if (commaParts.length > 1 && commaParts.every(p => p.includes(" "))) parts = commaParts;
  } else {
    parts = parts.flatMap(p => p.split(/\s*,\s*/).every(q => q.includes(" ")) ? p.split(/\s*,\s*/) : [p]);
  }
  return parts
    .map(clean)
    .filter(n => n.length > 1 && n.length <= 80 && !/^https?:/i.test(n) && !/\d{3,}/.test(n));
}

const BYLINE_SELECTORS = [
  '[itemprop="author"] [itemprop="name"]', '[itemprop="author"]', '[rel="author"]',
  ".author-name", ".byline__name", ".byline-name", ".article-author", ".post-author", ".entry-author",
  ".byline a", ".author a", ".byline", ".author",
];

/** Authors named in the visible byline when the markup has no metadata for them. */
function bylineCreators(doc: Document): Record<string, string>[] {
  // The article's own byline first, so comment and sidebar authors stay out.
  const scopes: ParentNode[] = [doc.querySelector("article"), doc.querySelector("main"), doc]
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  for (const scope of scopes) {
    for (const selector of BYLINE_SELECTORS) {
      const elements = Array.from(scope.querySelectorAll(selector)).slice(0, 10);
      const names = [...new Set(elements.flatMap(el =>
        splitAuthorText(el.getAttribute("content") || el.textContent || "")))];
      if (names.length > 0 && names.every(n => n.split(" ").length <= 6)) return names.map(splitName);
    }
  }
  return [];
}

/** Publication date written into the body: <time datetime>, itemprop="datePublished". */
function bodyDate(doc: Document): string {
  const el = doc.querySelector('[itemprop="datePublished"]')
    ?? doc.querySelector("article time[datetime], main time[datetime]")
    ?? doc.querySelector("time[datetime]");
  return clean(el?.getAttribute("content") || el?.getAttribute("datetime") || el?.textContent);
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** Page titles often end with the site name ("Story | Site"); the reference needs only the story. */
function stripSiteSuffix(title: string, site: string): string {
  if (!site) return title;
  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = title.replace(new RegExp(`\\s+[|\\-–—:·•]\\s+${escaped}$`, "i"), "");
  return stripped || title;
}

/**
 * Record for a page no translator recognised, from everything the page
 * declares and shows: meta tags, JSON-LD, the heading, byline and date in the
 * body, the site name, and today's date as the access date.
 */
export function webpageFromMeta(doc: Document, url: string): Record<string, any> {
  const ld = jsonLdWork(doc);
  const website = metaContent(doc, "og:site_name", "application-name")
    || ldText(ld?.isPartOf?.name ? ld.isPartOf : undefined)
    || ldText(ld?.publisher)
    || hostName(url);
  const title = metaContent(doc, "citation_title", "dc.title", "og:title", "twitter:title")
    || ldText(ld?.headline) || ldText(ld?.name)
    || clean(doc.querySelector("h1")?.textContent)
    || stripSiteSuffix(clean(doc.querySelector("title")?.textContent), website)
    || url;

  let creators = citationAuthors(doc, ld);
  if (creators.length === 0) creators = ldCreators(ld?.author ?? ld?.creator);
  if (creators.length === 0) {
    creators = splitAuthorText(metaContent(doc, "author", "dc.creator", "article:author", "parsely-author",
      "sailthru.author")).map(splitName);
  }
  if (creators.length === 0) creators = bylineCreators(doc);

  const date = metaContent(doc, "citation_publication_date", "citation_date", "dc.date", "dc.date.issued",
    "article:published_time", "date", "datePublished", "pubdate", "publish-date")
    || ldText(ld?.datePublished) || ldText(ld?.dateCreated)
    || bodyDate(doc);

  return {
    itemType: "webpage",
    title: stripSiteSuffix(clean(title), website),
    websiteTitle: website,
    creators: dedupeCreators(creators),
    date: date.replace(/T.*$/, ""),
    abstractNote: metaContent(doc, "description", "og:description", "dc.description") || ldText(ld?.description),
    language: doc.documentElement?.getAttribute("lang") || ldText(ld?.inLanguage),
    url,
    accessDate: "CURRENT_TIMESTAMP",
  };
}

/**
 * Authors from citation_author tags. Without a comma a tag gives no order
 * (ResearchGate writes "Hostiuc Sorin"), so JSON-LD's Person entries win
 * when they name as many people.
 */
function citationAuthors(doc: Document, ld: Record<string, any> | undefined): Record<string, string>[] {
  const tagged = Array.from(doc.querySelectorAll('meta[name="citation_author" i], meta[property="citation_author" i]'))
    .map(el => clean(el.getAttribute("content")))
    .filter(Boolean);
  if (tagged.length > 0 && tagged.every(name => !name.includes(","))) {
    const fromLd = ldCreators(ld?.author ?? ld?.creator);
    if (fromLd.length === tagged.length) return fromLd;
  }
  return tagged.map(splitName);
}

/**
 * The work as the page declares it in Google Scholar (citation_*) tags, which
 * name the article rather than the page showing it. Only fields present.
 */
export function citationTags(doc: Document): Record<string, any> {
  const tags: Record<string, any> = {};
  const set = (field: string, value: string) => {
    if (value) tags[field] = value;
  };
  set("title", clean(metaContent(doc, "citation_title")));
  const creators = dedupeCreators(citationAuthors(doc, jsonLdWork(doc)));
  if (creators.length > 0) tags.creators = creators;
  set("date", metaContent(doc, "citation_publication_date", "citation_date", "citation_cover_date")
    .replace(/\//g, "-").replace(/T.*$/, ""));
  set("publicationTitle", clean(metaContent(doc, "citation_journal_title")));
  set("journalAbbreviation", clean(metaContent(doc, "citation_journal_abbrev")));
  set("volume", metaContent(doc, "citation_volume"));
  set("issue", metaContent(doc, "citation_issue"));
  const first = metaContent(doc, "citation_firstpage");
  const last = metaContent(doc, "citation_lastpage");
  set("pages", first && last && last !== first ? `${first}-${last}` : first);
  set("ISSN", metaContent(doc, "citation_issn"));
  set("publisher", clean(metaContent(doc, "citation_publisher")));
  set("DOI", normalizeDoi(metaContent(doc, "citation_doi")));
  return tags;
}

/** Journal fields only fit a journal article; the rest fit every item type. */
const JOURNAL_FIELDS = new Set(["publicationTitle", "journalAbbreviation", "volume", "issue", "pages", "ISSN", "DOI"]);

/** The page's declared citation wins over what the generic translator guessed. */
export function applyCitationTags(item: Record<string, any>, tags: Record<string, any>): void {
  for (const [field, value] of Object.entries(tags)) {
    if (JOURNAL_FIELDS.has(field) && item.itemType !== "journalArticle") continue;
    if (field === "publisher" && !["book", "bookSection", "report"].includes(item.itemType)) continue;
    item[field] = value;
  }
}

/** File-type labels some sites put before the title: "(PDF) Title". */
function stripFileLabel(title: string): string {
  return title.replace(/^\((?:PDF|DOCX?|PPTX?)\)\s*/i, "");
}

function dedupeCreators(creators: Record<string, string>[]): Record<string, string>[] {
  const seen = new Set<string>();
  return creators.filter(c => {
    const key = (c.name ?? `${c.firstName} ${c.lastName}`).toLowerCase();
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Last resort when the site shows nothing to scripts or browsers: the link
 * itself, with a title read from its last path segment, the site and today's
 * access date. The result says it should be checked.
 */
export function webpageFromURL(url: string): Record<string, any> {
  const site = hostName(url);
  let title = "";
  try {
    const segments = new URL(url).pathname.split("/").map(s => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    const slug = segments.reverse().find(s => /[a-z]{3,}/i.test(s) && /[-_ ]/.test(s)) ?? "";
    const words = slug.replace(/\.[a-z0-9]{2,5}$/i, "").split(/[-_ ]+/).filter(w => w && !/^\d{5,}$/.test(w));
    if (words.length >= 2) title = words.join(" ").replace(/^./, c => c.toUpperCase());
  } catch {
    // not a parseable link; fall back to the site
  }
  return {
    itemType: "webpage",
    title: title || site || url,
    websiteTitle: site,
    creators: [],
    url,
    accessDate: "CURRENT_TIMESTAMP",
  };
}

/** Where each item type keeps the site or publication name. */
const SITE_FIELD: Record<string, string> = {
  webpage: "websiteTitle",
  blogPost: "blogTitle",
  forumPost: "forumTitle",
  newspaperArticle: "publicationTitle",
  magazineArticle: "publicationTitle",
};

/**
 * Translators sometimes return a web-type item with gaps (no author, no date)
 * that the page itself fills; fill only what is missing, never overwrite.
 */
export function fillThinItem(item: Record<string, any>, fromPage: Record<string, any>): void {
  const siteField = SITE_FIELD[item.itemType];
  if (!siteField) return;
  if (!clean(item.title)) item.title = fromPage.title;
  if (!(item.creators ?? []).some((c: any) => c && (c.lastName || c.firstName || c.name))) {
    item.creators = fromPage.creators;
  }
  if (!clean(item.date) && fromPage.date) item.date = fromPage.date;
  if (!clean(item[siteField]) && fromPage.websiteTitle) item[siteField] = fromPage.websiteTitle;
  if (!clean(item.abstractNote) && fromPage.abstractNote) item.abstractNote = fromPage.abstractNote;
  if (!clean(item.language) && fromPage.language) item.language = fromPage.language;
  if (!item.url) item.url = fromPage.url;
  if (!item.accessDate) item.accessDate = "CURRENT_TIMESTAMP";
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
