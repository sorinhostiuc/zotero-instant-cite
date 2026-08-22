import { describe, expect, it } from "vitest";

import { isWellFormedDoi, normalizeDoi, sameDoi, titlesAgree } from "../src/modules/utils/doi";

describe("normalizeDoi", () => {
  it("strips URL prefixes and the doi: scheme", () => {
    expect(normalizeDoi("https://doi.org/10.3390/medicina62020293")).toBe("10.3390/medicina62020293");
    expect(normalizeDoi("http://dx.doi.org/10.3390/medicina62020293")).toBe("10.3390/medicina62020293");
    expect(normalizeDoi(" doi: 10.3390/medicina62020293 ")).toBe("10.3390/medicina62020293");
    expect(normalizeDoi(undefined)).toBe("");
  });
});

describe("isWellFormedDoi", () => {
  it("accepts complete DOIs", () => {
    expect(isWellFormedDoi("10.3390/medicina62020293")).toBe(true);
    expect(isWellFormedDoi("10.1016/j.pec.2021.05.032")).toBe(true);
    expect(isWellFormedDoi("https://doi.org/10.1007/s11606-020-06407-8")).toBe(true);
  });

  it("rejects reference-list fragments that lost the article id", () => {
    // These match hundreds of papers in a free-text search — never identifiers.
    expect(isWellFormedDoi("10.1016/j.pec.2021.")).toBe(false);
    expect(isWellFormedDoi("10.1016/j.pec.2021-")).toBe(false);
    expect(isWellFormedDoi("10.1016/")).toBe(false);
    expect(isWellFormedDoi("10.1016")).toBe(false);
    expect(isWellFormedDoi("")).toBe(false);
  });
});

describe("sameDoi", () => {
  it("compares case-insensitively after normalization", () => {
    expect(sameDoi("10.3390/MEDICINA62020293", "https://doi.org/10.3390/medicina62020293")).toBe(true);
    expect(sameDoi("10.3390/medicina62020293", "10.1016/j.pec.2021.05.032")).toBe(false);
    expect(sameDoi("", "10.3390/medicina62020293")).toBe(false);
  });
});

describe("titlesAgree", () => {
  const medicina = "Non-Surgical Causes of Death in the Emergency Department: A Five-Year Monocentric Clinicopathological Study";

  it("accepts the same work across sources", () => {
    expect(titlesAgree(medicina, medicina.toUpperCase())).toBe(true);
    expect(titlesAgree(medicina, "Non-Surgical Causes of Death in the Emergency Department")).toBe(true);
    expect(titlesAgree(medicina, medicina.replace(/[-:]/g, " "))).toBe(true);
  });

  it("rejects a record that describes a different article", () => {
    expect(titlesAgree(medicina, "Shared decision-making in oncology consultations")).toBe(false);
    expect(titlesAgree(medicina, "Sudden Unexpected Infant Death")).toBe(false);
  });

  it("passes when one side has no title to contradict", () => {
    expect(titlesAgree("", "Anything")).toBe(true);
    expect(titlesAgree(medicina, undefined)).toBe(true);
  });
});
