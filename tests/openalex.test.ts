import { describe, it, expect } from "vitest";
import { parseOpenAlexResults, reconstructAbstract } from "../src/modules/api/openalex";
import fixture from "./fixtures/openalex-response.json";

describe("OpenAlex parser", () => {
  it("should parse works from OpenAlex response", () => {
    const results = parseOpenAlexResults(fixture);
    expect(results.length).toBeGreaterThan(0);
  });

  it("should extract title, authors, year, DOI", () => {
    const results = parseOpenAlexResults(fixture);
    const first = results[0];
    expect(first.title).toBeTruthy();
    expect(first.authors.length).toBeGreaterThan(0);
    expect(first.year).toBeGreaterThan(2000);
    expect(first.doi).toBeTruthy();
    expect(first.sources).toContain("OpenAlex");
  });

  it("should extract citation count and OA status", () => {
    const results = parseOpenAlexResults(fixture);
    const first = results[0];
    expect(first.citationCount).toBeGreaterThanOrEqual(0);
    expect(typeof first.isOpenAccess).toBe("boolean");
  });

  it("should reconstruct abstract from inverted index", () => {
    const inverted = { "Brain": [0], "injury": [1], "is": [2], "common": [3] };
    expect(reconstructAbstract(inverted)).toBe("Brain injury is common");
  });
});
