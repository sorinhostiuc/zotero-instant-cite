import { describe, it, expect } from "vitest";
import { scoreRelevance } from "../src/modules/utils/relevance";
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

describe("scoreRelevance", () => {
  it("should score higher when title matches query terms", () => {
    const paper = makePaper({ title: "traumatic brain injury biomarkers" });
    const score = scoreRelevance(paper, "brain injury");
    expect(score).toBeGreaterThan(0);
  });

  it("should score higher for more cited papers", () => {
    const lowCite = makePaper({ title: "brain injury", citationCount: 5 });
    const highCite = makePaper({ title: "brain injury", citationCount: 500 });
    expect(scoreRelevance(highCite, "brain")).toBeGreaterThan(scoreRelevance(lowCite, "brain"));
  });

  it("should boost recent papers", () => {
    const old = makePaper({ title: "brain injury", year: 2010 });
    const recent = makePaper({ title: "brain injury", year: new Date().getFullYear() });
    expect(scoreRelevance(recent, "brain")).toBeGreaterThan(scoreRelevance(old, "brain"));
  });

  it("should boost open access papers", () => {
    const closed = makePaper({ title: "brain injury", isOpenAccess: false });
    const open = makePaper({ title: "brain injury", isOpenAccess: true });
    expect(scoreRelevance(open, "brain")).toBeGreaterThan(scoreRelevance(closed, "brain"));
  });

  it("should strongly prefer the matching law number for legislative queries", () => {
    const correct = makePaper({ title: "Legea nr. 95/2006 privind reforma în sănătate" });
    const wrong = makePaper({ title: "Legea nr. 96/2006 privind reforma în sănătate" });

    expect(scoreRelevance(correct, "lege 95")).toBeGreaterThan(scoreRelevance(wrong, "lege 95"));
  });
});
