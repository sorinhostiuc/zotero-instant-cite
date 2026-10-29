import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  applyCitationTags, citationTags, fillThinItem, isBotCheckPage, paperFromTranslatorItem, translatorItemForSaving,
  webpageFromMeta, webpageFromURL,
} from "../src/modules/api/web-page";

const journalItem = {
  itemType: "journalArticle",
  title: "Informed consent in forensic practice",
  creators: [
    { firstName: "Sorin", lastName: "Hostiuc", creatorType: "author" },
    { lastName: "World Health Organization", fieldMode: 1, creatorType: "author" },
  ],
  date: "2021-03-04",
  publicationTitle: "Frontiers in Medicine",
  volume: "8",
  pages: "612345",
  ISBN: "978-3-0365-4193-8 3036541939",
  extra: "PMID: 33445566\nDOI: https://doi.org/10.3389/fmed.2021.612345",
  url: "https://www.frontiersin.org/articles/10.3389/fmed.2021.612345/full",
  accessDate: "CURRENT_TIMESTAMP",
  tags: ["consent", { tag: " ethics " }, { tag: "" }],
  attachments: [{ title: "Full Text PDF", mimeType: "application/pdf", url: "https://x.org/a.pdf" }],
  notes: [{ note: "n" }],
  seeAlso: [],
  id: "x1",
  complete: true,
};

describe("translator items", () => {
  it("maps fields for the result list and keeps the JSON for saving", () => {
    const paper = paperFromTranslatorItem(journalItem, "https://page.example");
    expect(paper).toMatchObject({
      id: "web:10.3389/fmed.2021.612345",
      title: "Informed consent in forensic practice",
      year: 2021,
      journal: "Frontiers in Medicine",
      doi: "10.3389/fmed.2021.612345",
      isbn: "9783036541938",
      pdfUrl: "https://x.org/a.pdf",
      sources: ["Web"],
      itemType: "journalArticle",
      url: journalItem.url,
    });
    expect(paper.authors).toEqual([
      { name: "Sorin Hostiuc", firstName: "Sorin", lastName: "Hostiuc", creatorType: "author" },
      { name: "World Health Organization", lastName: "World Health Organization", isCorporate: true, creatorType: "author" },
    ]);
    expect(paper.zoteroJSON).toBe(journalItem);
  });

  it("prepares the JSON the way Zotero's own saver does", () => {
    const json = translatorItemForSaving(journalItem, new Date("2026-10-25T09:00:00.123Z"));
    for (const field of ["attachments", "notes", "seeAlso", "id", "complete"]) expect(json).not.toHaveProperty(field);
    expect(json.creators).toEqual([
      { firstName: "Sorin", lastName: "Hostiuc", creatorType: "author" },
      { name: "World Health Organization", creatorType: "author" },
    ]);
    expect(json.tags).toEqual([{ tag: "consent", type: 1 }, { tag: "ethics", type: 1 }]);
    expect(json.accessDate).toBe("2026-10-25T09:00:00Z");
    expect(journalItem.accessDate).toBe("CURRENT_TIMESTAMP");
  });
});

describe("pages without a translator", () => {
  const parse = (html: string) => new JSDOM(html).window.document as unknown as Document;

  it("builds a webpage record from the meta tags", () => {
    const doc = parse(`<html lang="ro"><head>
      <title>Ignored tab title</title>
      <meta property="og:title" content="Proiecte  IT">
      <meta property="og:site_name" content="medleg.ro">
      <meta name="author" content="Sorin Hostiuc; Pop, Maria; https://x.org/me; Redacția">
      <meta property="article:published_time" content="2026-05-01T10:00:00Z">
      <meta name="description" content="Instrumente pentru cercetare.">
      </head><body></body></html>`);
    expect(webpageFromMeta(doc, "https://medleg.ro/it")).toEqual({
      itemType: "webpage",
      title: "Proiecte IT",
      websiteTitle: "medleg.ro",
      creators: [
        { firstName: "Sorin", lastName: "Hostiuc", creatorType: "author" },
        { lastName: "Pop", firstName: "Maria", creatorType: "author" },
        { name: "Redacția", creatorType: "author" },
      ],
      date: "2026-05-01",
      abstractNote: "Instrumente pentru cercetare.",
      language: "ro",
      url: "https://medleg.ro/it",
      accessDate: "CURRENT_TIMESTAMP",
    });
  });

  it("falls back to the tab title, then the link", () => {
    const titled = parse("<title> A page </title>");
    expect(webpageFromMeta(titled, "https://a.org").title).toBe("A page");
    const bare = parse("<p>x</p>");
    expect(webpageFromMeta(bare, "https://a.org").title).toBe("https://a.org");
  });

  it("recognises robot-check pages served as HTTP 200", () => {
    const akamai = `<html><head><meta http-equiv="refresh" content="5; URL='/x?bm-verify=AAQ'" />
      <title>&nbsp;</title><script>var i = 1;</script></head><body></body></html>`;
    expect(isBotCheckPage(parse(akamai), akamai)).toBe(true);
    const cloudflare = "<html><head><title>Just a moment...</title></head><body></body></html>";
    expect(isBotCheckPage(parse(cloudflare), cloudflare)).toBe(true);
    const page = "<html><head><title>Proiecte IT</title></head><body><p>text</p></body></html>";
    expect(isBotCheckPage(parse(page), page)).toBe(false);
  });

  it("recognises a robot check whose title is in another language", () => {
    const localized = `<html><head><title>Doar un moment...</title></head><body>
      <div id="challenge-stage"></div><script>window._cf_chl_opt = { cType: "managed" };</script>
      ${"<p>.</p>".repeat(800)}</body></html>`;
    expect(isBotCheckPage(parse(localized), localized)).toBe(true);
  });

  it("reads title, authors, date and site from JSON-LD", () => {
    const doc = parse(`<html lang="en"><head><title>Ignored</title>
      <script type="application/ld+json">{ "@context": "https://schema.org", "@graph": [
        { "@type": "WebSite", "name": "Wrong" },
        { "@type": "NewsArticle", "headline": "Autopsy findings in 2025",
          "author": [{ "@type": "Person", "name": "Jane Doe" },
                     { "@type": "Person", "givenName": "Ion", "familyName": "Popescu" },
                     { "@type": "Organization", "name": "News Desk" }],
          "datePublished": "2025-02-03T08:00:00+02:00",
          "publisher": { "@type": "Organization", "name": "Example News" },
          "description": "What the report found." } ] }</script>
      <script type="application/ld+json">{ broken</script>
      </head><body></body></html>`);
    const record = webpageFromMeta(doc, "https://news.example.org/a");
    expect(record).toMatchObject({
      title: "Autopsy findings in 2025",
      websiteTitle: "Example News",
      date: "2025-02-03",
      abstractNote: "What the report found.",
      language: "en",
      accessDate: "CURRENT_TIMESTAMP",
    });
    expect(record.creators).toEqual([
      { firstName: "Jane", lastName: "Doe", creatorType: "author" },
      { lastName: "Popescu", firstName: "Ion", creatorType: "author" },
      { name: "News Desk", creatorType: "author" },
    ]);
  });

  it("reads the heading, byline and date from the body when nothing declares them", () => {
    const doc = parse(`<html><head><title>Story about bones | Example</title></head><body>
      <aside><span class="author">Comment Writer</span></aside>
      <article><h1> Story about bones </h1>
        <p class="byline">By Jane Doe and John Smith</p>
        <time datetime="2024-11-30T09:15">30 Nov</time></article></body></html>`);
    const record = webpageFromMeta(doc, "https://www.example.org/story");
    expect(record).toMatchObject({ title: "Story about bones", websiteTitle: "example.org", date: "2024-11-30" });
    expect(record.creators.map((c: any) => c.lastName)).toEqual(["Doe", "Smith"]);
  });

  it("reads the citation the page declares in property= tags", () => {
    const doc = parse(`<html><head>
      <meta property="og:title" content="(PDF) Consent in prison">
      <meta property="citation_title" content="Consent in prison">
      <meta property="citation_author" content="Hostiuc Sorin">
      <meta property="citation_author" content="Dermengiu D.">
      <meta property="citation_publication_date" content="2015/06/01">
      <meta property="citation_journal_title" content="Romanian Journal of Legal Medicine">
      <meta property="citation_publisher" content="Romanian Society of Legal Medicine">
      <meta property="citation_issn" content="1221-8618">
      <meta property="citation_firstpage" content="12"><meta property="citation_lastpage" content="18">
      <script type="application/ld+json">{ "@type": "ScholarlyArticle", "author": [
        { "@type": "Person", "name": "Sorin Hostiuc" }, { "@type": "Person", "name": "Dan Dermengiu" }] }</script>
      </head><body></body></html>`);
    const tags = citationTags(doc);
    expect(tags).toEqual({
      title: "Consent in prison",
      creators: [
        { lastName: "Hostiuc", firstName: "Sorin", creatorType: "author" },
        { lastName: "Dermengiu", firstName: "Dan", creatorType: "author" },
      ],
      date: "2015-06-01",
      publicationTitle: "Romanian Journal of Legal Medicine",
      pages: "12-18",
      ISSN: "1221-8618",
      publisher: "Romanian Society of Legal Medicine",
    });
    expect(webpageFromMeta(doc, "https://rg.example/p").creators).toEqual(tags.creators);

    const guessed: Record<string, any> = { itemType: "journalArticle", title: "(PDF) Consent in prison",
      creators: [], date: "2026-09-26", publicationTitle: "ResearchGate" };
    applyCitationTags(guessed, tags);
    expect(guessed).toMatchObject({ title: "Consent in prison", date: "2015-06-01",
      publicationTitle: "Romanian Journal of Legal Medicine", pages: "12-18" });
    expect(guessed).not.toHaveProperty("publisher");
    const page: Record<string, any> = { itemType: "webpage", title: "T" };
    applyCitationTags(page, tags);
    expect(page).not.toHaveProperty("publicationTitle");
    expect(page.date).toBe("2015-06-01");
  });

  it("keeps the order of citation authors written with a comma", () => {
    const doc = parse(`<meta name="citation_author" content="de la Cruz, Ana Maria">
      <script type="application/ld+json">{ "@type": "ScholarlyArticle", "author": { "@type": "Person", "name": "Ana Maria de la Cruz" } }</script>`);
    expect(citationTags(doc).creators).toEqual([{ lastName: "de la Cruz", firstName: "Ana Maria", creatorType: "author" }]);
  });

  it("drops the site name the title ends with", () => {
    const doc = parse(`<meta property="og:title" content="Story - Example News">
      <meta property="og:site_name" content="Example News">`);
    expect(webpageFromMeta(doc, "https://example.org/s").title).toBe("Story");
  });
});

describe("pages that cannot be read", () => {
  it("builds a record from the link alone", () => {
    expect(webpageFromURL("https://www.example.org/news/2025/02/forensic-autopsy-findings-12345.html")).toEqual({
      itemType: "webpage",
      title: "Forensic autopsy findings",
      websiteTitle: "example.org",
      creators: [],
      url: "https://www.example.org/news/2025/02/forensic-autopsy-findings-12345.html",
      accessDate: "CURRENT_TIMESTAMP",
    });
    expect(webpageFromURL("https://example.org/a/123").title).toBe("example.org");
  });

  it("fills only the gaps of a thin translator record", () => {
    const fromPage = { title: "T", creators: [{ name: "Desk", creatorType: "author" }], date: "2025-01-02",
      websiteTitle: "Site", abstractNote: "A", language: "ro", url: "https://s.org/x" };
    const thin: Record<string, any> = { itemType: "webpage", title: "Own title", creators: [], url: "https://s.org/x" };
    fillThinItem(thin, fromPage);
    expect(thin).toMatchObject({ title: "Own title", creators: fromPage.creators, date: "2025-01-02",
      websiteTitle: "Site", accessDate: "CURRENT_TIMESTAMP" });
    const blog: Record<string, any> = { itemType: "blogPost", title: "B", creators: [], date: "2020" };
    fillThinItem(blog, fromPage);
    expect(blog).toMatchObject({ date: "2020", blogTitle: "Site" });
    const article: Record<string, any> = { itemType: "journalArticle", title: "J", creators: [] };
    fillThinItem(article, fromPage);
    expect(article.creators).toEqual([]);
  });
});
