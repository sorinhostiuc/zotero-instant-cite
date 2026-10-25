import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { isBotCheckPage, paperFromTranslatorItem, translatorItemForSaving, webpageFromMeta } from "../src/modules/api/web-page";

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
});
