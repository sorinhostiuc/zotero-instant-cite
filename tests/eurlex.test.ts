import { describe, expect, it } from "vitest";
import { buildFulltextExpression, buildSparqlQuery } from "../src/modules/api/eurlex";

describe("EUR-Lex free-text expression", () => {
  it("ANDs the significant words as quoted tokens", () => {
    expect(buildFulltextExpression("Medical Devices")).toBe('"medical" AND "devices"');
  });

  it("drops short words, stopwords and duplicates", () => {
    expect(buildFulltextExpression("protection of the data and data")).toBe('"protection" AND "data"');
  });

  it("splits on punctuation so quotes cannot break the SPARQL literal", () => {
    expect(buildFulltextExpression("Regulation (EU) 2016/679 o'brien \"x\"")).toBe(
      '"regulation" AND "2016" AND "679" AND "brien"',
    );
  });

  it("keeps accented letters", () => {
    expect(buildFulltextExpression("protecția datelor")).toBe('"protecția" AND "datelor"');
  });

  it("returns null when no word is usable", () => {
    expect(buildFulltextExpression("EU of the")).toBeNull();
    expect(buildFulltextExpression("   ")).toBeNull();
  });
});

describe("EUR-Lex SPARQL query", () => {
  it("uses Virtuoso's free-text index instead of scanning every title", () => {
    const sparql = buildSparqlQuery('"artificial" AND "intelligence"', 20);
    expect(sparql).toContain("?title bif:contains '\"artificial\" AND \"intelligence\"'");
    expect(sparql).not.toMatch(/CONTAINS\(LCASE/);
    expect(sparql).toContain("FILTER(lang(?title) = 'en')");
    expect(sparql).toContain("LIMIT 20");
  });
});
