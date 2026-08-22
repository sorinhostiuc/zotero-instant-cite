import { describe, it, expect, beforeAll } from "vitest";
import { parsePubMedArticles } from "../src/modules/api/pubmed";
import { readFileSync } from "fs";
import { join } from "path";
import { JSDOM } from "jsdom";

beforeAll(() => {
  // Provide DOMParser in Node environment for XML parsing
  if (typeof globalThis.DOMParser === "undefined") {
    const dom = new JSDOM();
    (globalThis as any).DOMParser = dom.window.DOMParser;
  }
});

describe("PubMed parser", () => {
  const xml = readFileSync(join(__dirname, "fixtures/pubmed-response.xml"), "utf-8");

  it("should parse articles from PubMed XML", () => {
    const results = parsePubMedArticles(xml);
    expect(results.length).toBeGreaterThan(0);
  });

  it("should extract title, authors, year, PMID", () => {
    const results = parsePubMedArticles(xml);
    const first = results[0];
    expect(first.title).toBeTruthy();
    expect(first.authors.length).toBeGreaterThan(0);
    expect(first.year).toBeGreaterThan(2000);
    expect(first.pmid).toBeTruthy();
    expect(first.sources).toContain("PubMed");
  });

  it("should extract DOI when available", () => {
    const results = parsePubMedArticles(xml);
    const withDoi = results.find((r) => r.doi);
    expect(withDoi).toBeTruthy();
  });

  it("should extract abstract", () => {
    const results = parsePubMedArticles(xml);
    const withAbstract = results.find((r) => r.abstract);
    expect(withAbstract?.abstract?.length).toBeGreaterThan(50);
  });
});
