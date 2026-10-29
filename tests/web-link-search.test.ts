import { beforeEach, describe, expect, it, vi } from "vitest";
import { orchestrateSearch } from "../src/modules/search-orchestrator";
import { detectQueryType } from "../src/modules/utils/query-detector";
import { identifiersFromURL, urlMatchKey } from "../src/modules/utils/url-identifiers";
import { lookupCrossRefDOI, lookupCrossRefPII } from "../src/modules/api/crossref";
import { searchPubMed } from "../src/modules/api/pubmed";
import { lookupOpenAlexWork } from "../src/modules/api/openalex";
import { translateWebPage } from "../src/modules/api/web-page";
import { searchZoteroLocal } from "../src/modules/api/zotero-local";

const empty = (source: string) => ({ source, results: [], totalCount: 0, searchTimeMs: 1 });
const hit = (source: string, title: string) => ({
  source,
  results: [{ id: source + ":1", title, authors: [], year: 2021, doi: "10.3389/fmed.2021.612345", isOpenAccess: false, sources: [source] }],
  totalCount: 1,
  searchTimeMs: 1,
});

vi.mock("../src/modules/api/crossref", () => ({ searchCrossRef: vi.fn(), lookupCrossRefDOI: vi.fn(), lookupCrossRefPII: vi.fn() }));
vi.mock("../src/modules/api/pubmed", () => ({ searchPubMed: vi.fn() }));
vi.mock("../src/modules/api/openalex", () => ({ searchOpenAlex: vi.fn(), lookupOpenAlexWork: vi.fn() }));
vi.mock("../src/modules/api/web-page", () => ({ translateWebPage: vi.fn() }));
vi.mock("../src/modules/api/zotero-local", () => ({ searchZoteroLocal: vi.fn() }));

describe("web link detection", () => {
  it("detects links, keeping doi.org links as DOIs", () => {
    expect(detectQueryType("https://doi.org/10.1016/j.legalmed.2020.101234").type).toBe("DOI");
    expect(detectQueryType("https://www.mdpi.com/2075-4418/11/2/123")).toEqual({
      type: "URL", value: "https://www.mdpi.com/2075-4418/11/2/123",
    });
    expect(detectQueryType("www.medleg.ro/en/")).toEqual({ type: "URL", value: "https://www.medleg.ro/en/" });
    expect(detectQueryType("forensic medicine https://x.org").type).toBe("KEYWORD");
  });

  it("reads DOIs from publisher links and drops view suffixes", () => {
    expect(identifiersFromURL("https://www.frontiersin.org/articles/10.3389/fmed.2021.612345/full"))
      .toEqual({ doi: "10.3389/fmed.2021.612345" });
    expect(identifiersFromURL("https://onlinelibrary.wiley.com/doi/epdf/10.1111/1556-4029.14500?af=R"))
      .toEqual({ doi: "10.1111/1556-4029.14500" });
    expect(identifiersFromURL("https://link.springer.com/content/pdf/10.1007/s00414-020-02300-1.pdf"))
      .toEqual({ doi: "10.1007/s00414-020-02300-1" });
    expect(identifiersFromURL("https://www.thelancet.com/journals/lancet/article/PIIS0140-6736(20)30183-5/fulltext"))
      .toEqual({});
    expect(identifiersFromURL("https://example.org/view?doi=10.1136%2Fbmj.m1234"))
      .toEqual({ doi: "10.1136/bmj.m1234" });
  });

  it("reads PMIDs and OpenAlex IDs from their sites", () => {
    expect(identifiersFromURL("https://pubmed.ncbi.nlm.nih.gov/33445566/")).toEqual({ pmid: "33445566" });
    expect(identifiersFromURL("https://www.ncbi.nlm.nih.gov/pubmed/12345678")).toEqual({ pmid: "12345678" });
    expect(identifiersFromURL("https://openalex.org/works/w2741809807")).toEqual({ openalexId: "W2741809807" });
  });

  it("reads Elsevier PIIs from ScienceDirect and linkinghub links", () => {
    expect(identifiersFromURL("https://www.sciencedirect.com/science/article/pii/S0379073820301234"))
      .toEqual({ pii: "S0379073820301234" });
    expect(identifiersFromURL("https://www.sciencedirect.com/science/article/abs/pii/s037907382030123x?via%3Dihub"))
      .toEqual({ pii: "S037907382030123X" });
    expect(identifiersFromURL("https://linkinghub.elsevier.com/retrieve/pii/S0379073826000228"))
      .toEqual({ pii: "S0379073826000228" });
    expect(identifiersFromURL("https://www.sciencedirect.com/journal/forensic-science-international")).toEqual({});
  });

  it("matches stored links regardless of scheme, www and trailing slash", () => {
    expect(urlMatchKey("https://www.medleg.ro/en/it-projects/#top")).toBe("medleg.ro/en/it-projects");
  });
});

describe("web link search", () => {
  beforeEach(() => {
    vi.mocked(searchZoteroLocal).mockReset().mockResolvedValue(empty("Zotero"));
    vi.mocked(lookupCrossRefDOI).mockReset().mockResolvedValue(empty("CrossRef"));
    vi.mocked(lookupCrossRefPII).mockReset().mockResolvedValue(empty("CrossRef"));
    vi.mocked(searchPubMed).mockReset().mockResolvedValue(empty("PubMed"));
    vi.mocked(lookupOpenAlexWork).mockReset().mockResolvedValue(empty("OpenAlex"));
    vi.mocked(translateWebPage).mockReset().mockResolvedValue(hit("Web", "Page record"));
  });

  it("looks up the DOI in the link and does not fetch the page when that works", async () => {
    vi.mocked(lookupCrossRefDOI).mockResolvedValue(hit("CrossRef", "Canonical record"));
    const result = await orchestrateSearch({ query: "https://www.frontiersin.org/articles/10.3389/fmed.2021.612345/full" });
    expect(lookupCrossRefDOI).toHaveBeenCalledWith("10.3389/fmed.2021.612345");
    expect(translateWebPage).not.toHaveBeenCalled();
    expect(result.papers.map(p => p.title)).toEqual(["Canonical record"]);
  });

  it("reads the page when the DOI is unknown to CrossRef and PubMed", async () => {
    const url = "https://zenodo.org/doi/10.5281/zenodo.1234567";
    const result = await orchestrateSearch({ query: url });
    expect(translateWebPage).toHaveBeenCalledWith(url);
    expect(result.papers.map(p => p.title)).toEqual(["Page record"]);
  });

  it("reads pages without identifiers even with every source disabled", async () => {
    const url = "https://www.mdpi.com/2075-4418/11/2/123";
    const result = await orchestrateSearch({ query: url, sources: [] });
    expect(translateWebPage).toHaveBeenCalledWith(url);
    expect(searchZoteroLocal).not.toHaveBeenCalled();
    expect(result.papers).toHaveLength(1);
  });

  it("uses PubMed for PubMed links", async () => {
    vi.mocked(searchPubMed).mockResolvedValue(hit("PubMed", "PubMed record"));
    await orchestrateSearch({ query: "https://pubmed.ncbi.nlm.nih.gov/33445566/" });
    expect(vi.mocked(searchPubMed).mock.calls[0][0].query).toBe("33445566");
    expect(translateWebPage).not.toHaveBeenCalled();
  });

  it("keeps the library copy and skips the page when the link is already stored", async () => {
    vi.mocked(searchZoteroLocal).mockResolvedValue(hit("Zotero", "Library copy"));
    const result = await orchestrateSearch({ query: "https://www.mdpi.com/2075-4418/11/2/123" });
    expect(translateWebPage).not.toHaveBeenCalled();
    expect(result.papers.map(p => p.title)).toEqual(["Library copy"]);
  });

  it("resolves ScienceDirect links through CrossRef without reading the page", async () => {
    vi.mocked(lookupCrossRefPII).mockResolvedValue(hit("CrossRef", "Canonical record"));
    const result = await orchestrateSearch({ query: "https://www.sciencedirect.com/science/article/pii/S0379073826000228" });
    expect(lookupCrossRefPII).toHaveBeenCalledWith("S0379073826000228");
    expect(translateWebPage).not.toHaveBeenCalled();
    expect(result.papers.map(p => p.title)).toEqual(["Canonical record"]);
  });

  it("shows the caveat of a record built from the link alone", async () => {
    vi.mocked(translateWebPage).mockResolvedValue({ ...hit("Web", "Link record"), notice: "Check the title" });
    const result = await orchestrateSearch({ query: "https://www.example.org/news/some-story" });
    expect(result.papers).toHaveLength(1);
    expect(result.errors).toEqual([{ source: "Web", error: "Check the title" }]);
  });

  it("reports a page that cannot be read", async () => {
    vi.mocked(translateWebPage).mockRejectedValue(new Error("The site refused the request (HTTP 403)"));
    const result = await orchestrateSearch({ query: "https://www.sciencedirect.com/science/article/pii/S0379073820301234" });
    expect(result.papers).toHaveLength(0);
    expect(result.errors).toEqual([{ source: "Web", error: "The site refused the request (HTTP 403)" }]);
  });
});
