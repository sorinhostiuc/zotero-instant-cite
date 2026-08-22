import { describe, it, expect, vi } from "vitest";

// Mock Zotero-dependent modules that auto-updater imports but we don't need for mergePaperFields
vi.mock("../src/modules/search-orchestrator", () => ({
  orchestrateSearch: vi.fn().mockResolvedValue({ papers: [], totalCount: 0, sourceCounts: {}, searchTimeMs: 0, errors: [] }),
}));

vi.mock("../src/modules/zotero-bridge", () => ({
  addToZotero: vi.fn(),
}));

vi.mock("../src/modules/preferences", () => ({
  getAutoUpdateMode: vi.fn().mockReturnValue("hybrid"),
}));

vi.mock("../src/modules/utils/legislative-detector", () => ({
  isLegislativeReference: vi.fn().mockReturnValue(null),
  parseLegislativeReference: vi.fn().mockReturnValue(null),
  applyLegislativeFormatting: vi.fn(),
}));

import { mergePaperFields } from "../src/modules/auto-updater";
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

describe("mergePaperFields", () => {
  it("should fill empty DOI from match", () => {
    const current = makePaper({ title: "A study", doi: undefined });
    const match = makePaper({ title: "A study", doi: "10.1234/test" });
    const diff = mergePaperFields(current, match);
    expect(diff).toContainEqual({ field: "doi", oldValue: "", newValue: "10.1234/test", isNew: true });
  });

  it("should pick longer title", () => {
    const current = makePaper({ title: "Short title" });
    const match = makePaper({ title: "A much longer and more complete title of the paper" });
    const diff = mergePaperFields(current, match);
    expect(diff).toContainEqual(expect.objectContaining({ field: "title", isNew: false }));
  });

  it("should NOT propose change if current is already better", () => {
    const current = makePaper({ title: "Long complete title here yes", doi: "10.1234/test" });
    const match = makePaper({ title: "Short", doi: "10.1234/test" });
    const diff = mergePaperFields(current, match);
    const titleChange = diff.find(d => d.field === "title");
    expect(titleChange).toBeUndefined();
  });

  it("should prefer more authors", () => {
    const current = makePaper({ authors: [{ name: "Smith J" }] });
    const match = makePaper({ authors: [{ name: "Smith, John" }, { name: "Doe, Jane" }] });
    const diff = mergePaperFields(current, match);
    expect(diff).toContainEqual(expect.objectContaining({ field: "authors" }));
  });

  it("should fill empty abstract", () => {
    const current = makePaper({ abstract: undefined });
    const match = makePaper({ abstract: "This is the abstract text." });
    const diff = mergePaperFields(current, match);
    expect(diff).toContainEqual(expect.objectContaining({ field: "abstract", isNew: true }));
  });

  it("should return empty array if no improvements", () => {
    const current = makePaper({
      title: "Complete title", doi: "10.1234/test",
      authors: [{ name: "Smith, John" }, { name: "Doe, Jane" }],
      abstract: "Full abstract here.",
    });
    const match = makePaper({ title: "Short", doi: "10.1234/test", authors: [{ name: "Smith J" }] });
    const diff = mergePaperFields(current, match);
    expect(diff).toHaveLength(0);
  });

  it("should pick higher citation count", () => {
    const current = makePaper({ citationCount: 5 });
    const match = makePaper({ citationCount: 150 });
    const diff = mergePaperFields(current, match);
    expect(diff).toContainEqual(expect.objectContaining({ field: "citationCount" }));
  });

  it("should not consider truncated titles as better", () => {
    const current = makePaper({ title: "Full title here" });
    const match = makePaper({ title: "Full title here..." });
    const diff = mergePaperFields(current, match);
    const titleChange = diff.find(d => d.field === "title");
    expect(titleChange).toBeUndefined();
  });
});
