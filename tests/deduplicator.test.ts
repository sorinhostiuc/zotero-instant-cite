import { describe, it, expect } from "vitest";
import { deduplicateResults, titleSimilarity } from "../src/modules/utils/deduplicator";
import type { PaperResult } from "../src/modules/api/types";

const makePaper = (overrides: Partial<PaperResult>): PaperResult => ({
  id: "test:1",
  title: "Test Paper",
  authors: [],
  year: 2023,
  isOpenAccess: false,
  sources: ["PubMed"],
  ...overrides,
});

describe("deduplicateResults", () => {
  it("should merge papers with same DOI", () => {
    const papers = [
      makePaper({ id: "pubmed:1", doi: "10.1234/test", sources: ["PubMed"], abstract: "An abstract" }),
      makePaper({ id: "openalex:1", doi: "10.1234/test", sources: ["OpenAlex"], citationCount: 50 }),
    ];
    const result = deduplicateResults(papers);
    expect(result).toHaveLength(1);
    expect(result[0].sources).toContain("PubMed");
    expect(result[0].sources).toContain("OpenAlex");
    expect(result[0].citationCount).toBe(50);
  });

  it("should normalize DOI case", () => {
    const papers = [
      makePaper({ id: "a", doi: "10.1234/TEST", sources: ["PubMed"] }),
      makePaper({ id: "b", doi: "10.1234/test", sources: ["OpenAlex"] }),
    ];
    expect(deduplicateResults(papers)).toHaveLength(1);
  });

  it("should keep papers without DOI if titles differ", () => {
    const papers = [
      makePaper({ id: "a", title: "Paper Alpha", sources: ["PubMed"] }),
      makePaper({ id: "b", title: "Paper Beta", sources: ["OpenAlex"] }),
    ];
    expect(deduplicateResults(papers)).toHaveLength(2);
  });

  it("keeps every field either source provided", () => {
    const papers = [
      makePaper({
        id: "crossref:1", doi: "10.1234/test", sources: ["CrossRef"],
        volume: "62", issue: "2", journalAbbreviation: "Medicina",
      }),
      makePaper({
        id: "epmc:1", doi: "10.1234/test", sources: ["EuropePMC"],
        pages: "293", issn: "1010-660X", pmid: "40123456", url: "https://example.org/a",
      }),
    ];
    const [merged] = deduplicateResults(papers);
    expect(merged.volume).toBe("62");
    expect(merged.issue).toBe("2");
    expect(merged.journalAbbreviation).toBe("Medicina");
    expect(merged.pages).toBe("293");
    expect(merged.issn).toBe("1010-660X");
    expect(merged.pmid).toBe("40123456");
    expect(merged.url).toBe("https://example.org/a");
  });

  it("does not turn a merged book into a journal article", () => {
    const papers = [
      makePaper({
        id: "openlibrary:1", title: "Forensic Pathology", doi: "10.1234/book",
        sources: ["OpenLibrary"], itemType: "book", isbn: "9780123456789",
      }),
      makePaper({
        id: "googlebooks:1", title: "Forensic Pathology", doi: "10.1234/book",
        sources: ["GoogleBooks"], publisher: "CRC Press", place: "Boca Raton",
      }),
    ];
    const [merged] = deduplicateResults(papers);
    expect(merged.itemType).toBe("book");
    expect(merged.isbn).toBe("9780123456789");
    expect(merged.publisher).toBe("CRC Press");
    expect(merged.place).toBe("Boca Raton");
  });

  it("takes the item type from whichever source supplied one", () => {
    const papers = [
      makePaper({ id: "a", doi: "10.1234/case", sources: ["Zotero"] }),
      makePaper({ id: "b", doi: "10.1234/case", sources: ["ECHR"], itemType: "case", court: "ECHR" }),
    ];
    const [merged] = deduplicateResults(papers);
    expect(merged.itemType).toBe("case");
    expect(merged.court).toBe("ECHR");
  });

  it("should merge papers without DOI if titles are very similar", () => {
    const papers = [
      makePaper({ id: "a", title: "Blood biomarkers for traumatic brain injury", sources: ["PubMed"] }),
      makePaper({ id: "b", title: "Blood Biomarkers for Traumatic Brain Injury", sources: ["OpenAlex"] }),
    ];
    expect(deduplicateResults(papers)).toHaveLength(1);
  });
});

describe("titleSimilarity", () => {
  it("should return 1.0 for identical strings", () => {
    expect(titleSimilarity("hello", "hello")).toBe(1.0);
  });

  it("should return high similarity for case differences", () => {
    expect(titleSimilarity("Hello World", "hello world")).toBeGreaterThan(0.95);
  });

  it("should return low similarity for very different strings", () => {
    expect(titleSimilarity("alpha beta", "gamma delta epsilon")).toBeLessThan(0.5);
  });
});

// ─── Legislative dedup ───────────────────────────────────────────────
//
// The default Jaccard-on-title fallback is too strict for laws because
// citation forms vary widely ("Legea nr. 46/2003 privind drepturile
// pacientului" vs "Lege nr. 46/2003"). When we can extract a canonical
// legal key (jurisdiction + subType + codeNumber), we use it as the
// dedup key — same identity as DOI for papers.

describe("deduplicateResults — legislative items", () => {
  it("merges Romanian laws with same code despite citation form variation", () => {
    const papers = [
      makePaper({
        id: "a",
        title: "Legea nr. 46/2003 privind drepturile pacientului",
        sources: ["Zotero"],
      }),
      makePaper({
        id: "b",
        title: "Lege nr. 46/2003",
        sources: ["EUR-Lex"],
      }),
    ];
    const result = deduplicateResults(papers);
    expect(result).toHaveLength(1);
    expect(result[0].sources).toContain("Zotero");
    expect(result[0].sources).toContain("EUR-Lex");
  });

  it("merges Romanian law citation with abbreviated form (L. nr.)", () => {
    const papers = [
      makePaper({ id: "a", title: "Legea nr. 95/2006 privind reforma în sănătate" }),
      makePaper({ id: "b", title: "L. nr. 95/2006" }),
    ];
    expect(deduplicateResults(papers)).toHaveLength(1);
  });

  it("does NOT merge laws with different subType (Lege vs Decret-lege)", () => {
    const papers = [
      makePaper({ id: "a", title: "Legea nr. 46/2003" }),
      makePaper({ id: "b", title: "Decret-lege nr. 46/2003" }),
    ];
    expect(deduplicateResults(papers)).toHaveLength(2);
  });

  it("does NOT merge EU Regulation and Directive sharing a number", () => {
    const papers = [
      makePaper({ id: "a", title: "Regulation (EU) 2016/679 on data protection" }),
      makePaper({ id: "b", title: "Directive 2016/679 on something" }),
    ];
    expect(deduplicateResults(papers)).toHaveLength(2);
  });

  it("merges OUG with different verbose forms", () => {
    const papers = [
      makePaper({ id: "a", title: "OUG nr. 57/2019 privind Codul administrativ" }),
      makePaper({ id: "b", title: "Ordonanța de urgență nr. 57/2019" }),
    ];
    expect(deduplicateResults(papers)).toHaveLength(1);
  });

  it("merges law-without-year with same law-with-year (partial match)", () => {
    const papers = [
      makePaper({ id: "a", title: "Legea nr. 46/2003 privind drepturile pacientului" }),
      makePaper({ id: "b", title: "Legea nr. 46 — drepturile pacienților" }),
    ];
    expect(deduplicateResults(papers)).toHaveLength(1);
  });

  it("does NOT merge same number across different jurisdictions", () => {
    const papers = [
      makePaper({ id: "a", title: "Legea nr. 95/2006" }),               // RO
      makePaper({ id: "b", title: "Loi n° 2006-95 du 1 janvier 2006" }), // FR
    ];
    expect(deduplicateResults(papers)).toHaveLength(2);
  });

  it("falls back to title similarity for non-legislative items (no regression)", () => {
    const papers = [
      makePaper({ id: "a", title: "Blood biomarkers for traumatic brain injury" }),
      makePaper({ id: "b", title: "Blood Biomarkers for Traumatic Brain Injury" }),
    ];
    expect(deduplicateResults(papers)).toHaveLength(1);
  });
});
