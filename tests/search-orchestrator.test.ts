import { describe, it, expect, vi } from "vitest";
import { orchestrateSearch, type SearchProgress } from "../src/modules/search-orchestrator";
import { searchPubMed } from "../src/modules/api/pubmed";
import { searchOpenLibrary } from "../src/modules/api/open-library";

// Mock all API modules
vi.mock("../src/modules/api/pubmed", () => ({
  searchPubMed: vi.fn().mockResolvedValue({
    source: "PubMed",
    results: [
      { id: "pubmed:1", title: "Brain Injury Study", authors: [], year: 2023, doi: "10.1234/test", isOpenAccess: false, sources: ["PubMed"] },
    ],
    totalCount: 1,
    searchTimeMs: 100,
  }),
}));

vi.mock("../src/modules/api/europepmc", () => ({
  searchEuropePMC: vi.fn().mockResolvedValue({
    source: "EuropePMC",
    results: [
      { id: "europepmc:1", title: "Brain Injury Study", authors: [], year: 2023, doi: "10.1234/test", isOpenAccess: true, sources: ["EuropePMC"] },
    ],
    totalCount: 1,
    searchTimeMs: 120,
  }),
}));

vi.mock("../src/modules/api/crossref", () => ({
  searchCrossRef: vi.fn().mockResolvedValue({
    source: "CrossRef",
    results: [
      { id: "crossref:10.1234/test", title: "Brain Injury Study", authors: [], year: 2023, doi: "10.1234/test", isOpenAccess: false, citationCount: 45, sources: ["CrossRef"] },
    ],
    totalCount: 1,
    searchTimeMs: 150,
  }),
}));

vi.mock("../src/modules/api/doaj", () => ({
  searchDOAJ: vi.fn().mockResolvedValue({
    source: "DOAJ",
    results: [],
    totalCount: 0,
    searchTimeMs: 80,
  }),
}));

vi.mock("../src/modules/api/open-library", () => ({
  searchOpenLibrary: vi.fn().mockResolvedValue({
    source: "OpenLibrary",
    results: [],
    totalCount: 0,
    searchTimeMs: 100,
  }),
}));

// Two library items whose titles match the query far worse than the CrossRef
// hit — the point of the tiering is that they still come first.
vi.mock("../src/modules/api/zotero-local", () => ({
  searchZoteroLocal: vi.fn().mockResolvedValue({
    source: "Zotero",
    results: [
      { id: "zotero-local:42", title: "Head trauma notes", authors: [], year: 2019, doi: "10.9999/local-a", isOpenAccess: false, sources: ["Zotero"], _zoteroItemId: 42 },
      { id: "zotero-local:7", title: "Concussion review", authors: [], year: 2018, doi: "10.9999/local-b", isOpenAccess: false, sources: ["Zotero"], _zoteroItemId: 7 },
    ],
    totalCount: 2,
    searchTimeMs: 5,
  }),
}));

describe("orchestrateSearch", () => {
  it("should search all sources in parallel and deduplicate by DOI", async () => {
    const result = await orchestrateSearch({ query: "brain injury" });
    // Same DOI across PubMed, EuropePMC, CrossRef → should be merged into 1 result
    const external = result.papers.filter(p => !p.sources.includes("Zotero"));
    expect(external.length).toBe(1);
    expect(external[0].sources).toContain("PubMed");
    expect(external[0].sources).toContain("EuropePMC");
    expect(external[0].sources).toContain("CrossRef");
  });

  it("should report per-source counts", async () => {
    const result = await orchestrateSearch({ query: "brain injury" });
    expect(result.sourceCounts.PubMed).toBe(1);
    expect(result.sourceCounts.EuropePMC).toBe(1);
    expect(result.sourceCounts.CrossRef).toBe(1);
  });

  it("ranks library results above internet results despite a weaker title match", async () => {
    const result = await orchestrateSearch({ query: "brain injury" });

    // "Brain Injury Study" matches the query exactly and has 45 citations;
    // the library items match nothing. Provenance still wins.
    expect(result.papers.slice(0, 2).every(p => p.sources.includes("Zotero"))).toBe(true);
    expect(result.papers[result.papers.length - 1].title).toBe("Brain Injury Study");
  });

  it("ranks items cited in the document above the rest of the library", async () => {
    const result = await orchestrateSearch({
      query: "brain injury",
      prioritizedItemIds: new Set([7]),
    });

    expect(result.papers.map(p => p.id)).toEqual([
      "zotero-local:7",
      "zotero-local:42",
      "pubmed:1",
    ]);
  });
});

describe("orchestrateSearch advanced search", () => {
  it("sends an ISBN to the book catalogues only", async () => {
    vi.mocked(searchPubMed).mockClear();
    vi.mocked(searchOpenLibrary).mockClear();
    await orchestrateSearch({ query: "978-3-0365-4193-8", sources: ["OpenLibrary", "PubMed"] });
    expect(searchOpenLibrary).toHaveBeenCalledWith(expect.objectContaining({ query: "9783036541938" }));
    expect(searchPubMed).not.toHaveBeenCalled();
  });

  it("drops results that miss the fielded constraints", async () => {
    const result = await orchestrateSearch({
      query: "",
      sources: ["Zotero", "PubMed"],
      fields: { title: "brain injury" },
    });
    expect(result.papers.map(p => p.id)).toEqual(["pubmed:1"]);
  });
});

describe("orchestrateSearch progress", () => {
  it("shows each source as it answers instead of waiting for the slowest", async () => {
    let releasePubMed!: () => void;
    vi.mocked(searchPubMed).mockImplementationOnce(() => new Promise((resolve) => {
      releasePubMed = () => resolve({
        source: "PubMed",
        results: [{ id: "pubmed:9", title: "Slow answer", authors: [], year: 2020, isOpenAccess: false, sources: ["PubMed"] }],
        totalCount: 1,
        searchTimeMs: 90000,
      });
    }));

    const updates: SearchProgress[] = [];
    const search = orchestrateSearch(
      { query: "brain injury", sources: ["Zotero", "PubMed", "CrossRef"] },
      (p) => updates.push(p),
    );

    await vi.waitFor(() => expect(updates.at(-1)?.pending).toEqual(["PubMed"]));
    // The library hits come first, alone, before any internet source answers.
    expect(updates[0].papers.map(p => p.id)).toEqual(["zotero-local:42", "zotero-local:7"]);
    expect(updates[0].pending).toEqual(["PubMed", "CrossRef"]);
    // CrossRef is on screen while PubMed is still out.
    expect(updates.at(-1)!.papers.map(p => p.id)).toContain("crossref:10.1234/test");

    releasePubMed();
    const result = await search;
    expect(updates.at(-1)!.pending).toEqual([]);
    expect(result.papers.map(p => p.id)).toEqual(updates.at(-1)!.papers.map(p => p.id));
    expect(result.papers.map(p => p.id)).toContain("pubmed:9");
    expect(result.sourceCounts).toEqual({ Zotero: 2, PubMed: 1, CrossRef: 1 });
  });

  it("keeps the same final result whether or not progress is requested", async () => {
    const plain = await orchestrateSearch({ query: "brain injury" });
    const withProgress = await orchestrateSearch({ query: "brain injury" }, () => {});
    expect(withProgress.papers.map(p => p.id)).toEqual(plain.papers.map(p => p.id));
    expect(withProgress.sourceCounts).toEqual(plain.sourceCounts);
  });
});
