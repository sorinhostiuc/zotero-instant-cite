import { describe, it, expect } from "vitest";
import { parseRoLexResults } from "../src/modules/api/ro-lex";
import fixture from "./fixtures/rolex-response.json";

describe("RO-Lex parser", () => {
  it("maps every hit to a PaperResult tagged with the RO-Lex source", () => {
    const results = parseRoLexResults(fixture as any);
    expect(results.length).toBe(fixture.hits.length);
    for (const r of results) {
      expect(r.sources).toContain("RO-Lex");
      expect(r.title).toBeTruthy();
      expect(r.id.startsWith("rolex:")).toBe(true);
    }
  });

  it("resolves a relative url_source to an absolute legis.medleg.ro URL", () => {
    const results = parseRoLexResults(fixture as any);
    for (const r of results) {
      expect(r.url?.startsWith("https://legis.medleg.ro/")).toBe(true);
    }
  });

  it("derives the year from the ISO publication date", () => {
    // First fixture hit is a REGULAMENT dated 2020-10-22.
    const results = parseRoLexResults(fixture as any);
    expect(results[0].year).toBe(2020);
  });

  it("falls back to a year in the title when the date is missing", () => {
    // "ORDONANȚĂ DE URGENȚĂ nr. 150/2022 ..." has date_published: null.
    const results = parseRoLexResults(fixture as any);
    const oug = results.find(r => r.journal?.includes("Ordonanță") || r.title.includes("ORDONANȚĂ"));
    expect(oug?.year).toBe(2022);
  });

  it("classifies a Constitutional Court decision as a case and sets the court", () => {
    const results = parseRoLexResults(fixture as any);
    const ccr = results.find(r => r.itemType === "case");
    expect(ccr).toBeTruthy();
    expect(ccr?.court).toBe("Curtea Constituțională a României");
  });

  it("strips highlight markup from the snippet abstract", () => {
    const results = parseRoLexResults(fixture as any);
    for (const r of results) {
      if (r.abstract) expect(r.abstract).not.toContain("<");
    }
  });

  it("keeps documents with an unknown year when a year filter is applied", () => {
    const data = { total: 1, hits: [{ source_id: "x", doc_type: "ORDIN", title: "Ordin fără an", date_published: null }] };
    const filtered = parseRoLexResults(data, { query: "x", yearFrom: 2015 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].year).toBe(0);
  });

  it("filters out documents older than yearFrom", () => {
    const data = {
      total: 2,
      hits: [
        { source_id: "old", doc_type: "LEGE", title: "Lege veche", date_published: "1999-01-01" },
        { source_id: "new", doc_type: "LEGE", title: "Lege nouă", date_published: "2020-01-01" },
      ],
    };
    const filtered = parseRoLexResults(data, { query: "x", yearFrom: 2015 });
    expect(filtered.map(r => r.id)).toEqual(["rolex:new"]);
  });

  it("returns an empty result set for a blank response", () => {
    expect(parseRoLexResults({})).toEqual([]);
    expect(parseRoLexResults({ hits: [] })).toEqual([]);
  });
});
