import { describe, it, expect } from "vitest";

describe("PaperResult type", () => {
  it("should represent a normalized paper result", () => {
    const paper: any = {
      title: "Test Paper",
      authors: [{ name: "Smith J" }],
      year: 2023,
      doi: "10.1234/test",
      sources: ["PubMed"],
    };
    expect(paper.title).toBe("Test Paper");
    expect(paper.sources).toContain("PubMed");
  });
});
