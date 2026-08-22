import { describe, it, expect } from "vitest";
import { detectQueryType } from "../src/modules/utils/query-detector";

describe("detectQueryType", () => {
  it("should detect DOI", () => {
    expect(detectQueryType("10.1016/S1474-4422(23)00123-4")).toEqual({
      type: "DOI",
      value: "10.1016/S1474-4422(23)00123-4",
    });
  });

  it("should detect DOI with https prefix", () => {
    expect(detectQueryType("https://doi.org/10.1016/test")).toEqual({
      type: "DOI",
      value: "10.1016/test",
    });
  });

  it("should detect PMID (8-digit number)", () => {
    expect(detectQueryType("36789012")).toEqual({ type: "PMID", value: "36789012" });
  });

  it("should detect OpenAlex ID", () => {
    expect(detectQueryType("W4321098765")).toEqual({
      type: "OPENALEX_ID",
      value: "W4321098765",
    });
  });

  it("should fall back to KEYWORD for regular text", () => {
    expect(detectQueryType("traumatic brain injury")).toEqual({
      type: "KEYWORD",
      value: "traumatic brain injury",
    });
  });

  it("should trim whitespace", () => {
    expect(detectQueryType("  36789012  ")).toEqual({ type: "PMID", value: "36789012" });
  });
});
