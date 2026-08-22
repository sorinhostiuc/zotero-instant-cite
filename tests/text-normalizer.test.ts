import { describe, it, expect } from "vitest";
import { normalizeForSearch, normalizeForDisplay } from "../src/modules/utils/text-normalizer";

describe("normalizeForSearch", () => {
  it("should replace ligatures", () => {
    expect(normalizeForSearch("eﬃcacy and eﬀect of ﬁbrosis")).toBe("efficacy and effect of fibrosis");
  });

  it("should replace typographic punctuation", () => {
    expect(normalizeForSearch("it\u2019s a \u201Ctest\u201D \u2013 right\u2026")).toBe("it's a \"test\" - right...");
  });

  it("should strip Romanian diacritics", () => {
    expect(normalizeForSearch("Legea sănătății publice")).toBe("legea sanatatii publice");
  });

  it("should strip Romanian cedilla variants (old encoding)", () => {
    expect(normalizeForSearch("referin\u0163a \u015Fi")).toBe("referinta si");
  });

  it("should strip French diacritics", () => {
    expect(normalizeForSearch("Décret n° 2019 réglementation")).toBe("decret n 2019 reglementation");
  });

  it("should strip German umlauts", () => {
    expect(normalizeForSearch("Verordnung über Ärzte")).toBe("verordnung uber arzte");
  });

  it("should collapse whitespace", () => {
    expect(normalizeForSearch("  multiple   spaces  ")).toBe("multiple spaces");
  });

  it("should handle empty string", () => {
    expect(normalizeForSearch("")).toBe("");
  });

  it("should lowercase", () => {
    expect(normalizeForSearch("ABC DEF")).toBe("abc def");
  });

  it("should handle mixed ligatures and diacritics", () => {
    expect(normalizeForSearch("Eﬃcacité du traitement")).toBe("efficacite du traitement");
  });
});

describe("normalizeForDisplay", () => {
  it("should replace ligatures but keep diacritics", () => {
    expect(normalizeForDisplay("eﬃcacy of ﬁbrosis în sănătate")).toBe("efficacy of fibrosis în sănătate");
  });

  it("should fix Romanian cedilla to comma-below", () => {
    expect(normalizeForDisplay("referin\u0163\u0103 \u015Fi")).toBe("referin\u021B\u0103 \u0219i");
  });

  it("should replace smart quotes with straight quotes", () => {
    expect(normalizeForDisplay("\u201Ctest\u201D")).toBe("\"test\"");
  });

  it("should replace em/en dash with hyphen", () => {
    expect(normalizeForDisplay("a \u2013 b \u2014 c")).toBe("a - b - c");
  });

  it("should NOT lowercase", () => {
    expect(normalizeForDisplay("ABC")).toBe("ABC");
  });
});
