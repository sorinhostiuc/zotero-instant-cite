import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { fetchJSON, fetchXML } from "../src/modules/api/base-client";
import { canFetchAbstract, cleanAbstract, clearAbstractCache, fetchAbstract } from "../src/modules/api/abstract-fetch";
import { renderResults } from "../src/modules/result-renderer";
import type { PaperResult } from "../src/modules/api/types";

vi.mock("../src/modules/api/base-client", () => ({ fetchJSON: vi.fn(), fetchXML: vi.fn() }));
vi.mock("../src/modules/preferences", () => ({ getOpenAlexApiKey: () => "" }));

const paper = (extra: Partial<PaperResult> = {}): PaperResult => ({
  id: "crossref:1", title: "T", authors: [], isOpenAccess: false, sources: ["CrossRef"], ...extra,
});

let window: JSDOM["window"];

beforeAll(() => {
  window = new JSDOM("<div id='results-container'></div>").window;
  (globalThis as any).DOMParser = window.DOMParser;
});

beforeEach(() => {
  vi.mocked(fetchJSON).mockReset();
  vi.mocked(fetchXML).mockReset();
  clearAbstractCache();
});

describe("fetchAbstract", () => {
  it("uses the record's own abstract without any request", async () => {
    expect(await fetchAbstract(paper({ abstract: " Known. " }))).toBe("Known.");
    expect(fetchJSON).not.toHaveBeenCalled();
  });

  it("reads PubMed first for a PMID, with section labels", async () => {
    const xml = new window.DOMParser().parseFromString(
      "<PubmedArticleSet><Abstract><AbstractText Label='BACKGROUND'>Why.</AbstractText>"
      + "<AbstractText Label='RESULTS'>What.</AbstractText></Abstract></PubmedArticleSet>", "text/xml");
    vi.mocked(fetchXML).mockResolvedValue(xml as any);
    const p = paper({ pmid: "123", doi: "10.1/x" });
    expect(await fetchAbstract(p)).toBe("BACKGROUND: Why. RESULTS: What.");
    expect(p.abstract).toBe("BACKGROUND: Why. RESULTS: What.");
    expect(fetchJSON).not.toHaveBeenCalled();
  });

  it("falls through the DOI sources until one has text", async () => {
    vi.mocked(fetchJSON).mockImplementation(async (url: string) => {
      if (url.includes("openalex")) throw new Error("HTTP 404");
      if (url.includes("europepmc")) return { resultList: { result: [] } };
      if (url.includes("crossref")) {
        return { message: { abstract: "<jats:title>Abstract</jats:title><jats:p>Deaths &amp; injuries.</jats:p>" } };
      }
      throw new Error("unexpected " + url);
    });
    expect(await fetchAbstract(paper({ doi: "10.1016/j.legalmed.2020.101234" }))).toBe("Deaths & injuries.");
    const urls = vi.mocked(fetchJSON).mock.calls.map(c => c[0]);
    expect(urls[0]).toContain("/works/doi:10.1016/j.legalmed.2020.101234?");
    expect(urls[2]).toContain("api.crossref.org/works/10.1016/j.legalmed.2020.101234?");
  });

  it("rebuilds OpenAlex inverted indexes and asks once per paper", async () => {
    vi.mocked(fetchJSON).mockResolvedValue({ abstract_inverted_index: { world: [1], Hello: [0] } });
    const p = paper({ openalexId: "https://openalex.org/W42" });
    const [a, b] = await Promise.all([fetchAbstract(p), fetchAbstract(p)]);
    expect(a).toBe("Hello world");
    expect(b).toBe("Hello world");
    expect(fetchJSON).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchJSON).mock.calls[0][0]).toContain("/works/W42?select=abstract_inverted_index");
  });

  it("returns undefined when no source has one", async () => {
    vi.mocked(fetchJSON).mockResolvedValue({});
    expect(await fetchAbstract(paper({ doi: "10.1/none" }))).toBeUndefined();
  });

  it("only offers a lookup when there is something to look up by", () => {
    expect(canFetchAbstract(paper())).toBe(false);
    expect(canFetchAbstract(paper({ doi: "10.1/x" }))).toBe(true);
    expect(cleanAbstract("<p>A&#x2013;B</p><p>C</p>")).toBe("A–B C");
    expect(cleanAbstract("Abstract Array programming")).toBe("Array programming");
    expect(cleanAbstract("Abstraction layers")).toBe("Abstraction layers");
  });
});

describe("Abstract button on result cards", () => {
  it("fetches only on click and toggles the panel", async () => {
    vi.mocked(fetchJSON).mockResolvedValue({ abstract_inverted_index: { Lazy: [0] } });
    const doc = window.document;
    renderResults(doc, [paper({ doi: "10.1/lazy" }), paper({ id: "x:2" })], () => {}, () => {}, new Set());
    const cards = doc.querySelectorAll(".result-card");
    const buttons = (i: number) => Array.from(cards[i].querySelectorAll("button")).map(b => b.textContent);
    expect(buttons(0)).toContain("Abstract");
    expect(buttons(1)).not.toContain("Abstract");
    expect(fetchJSON).not.toHaveBeenCalled();

    const btn = Array.from(cards[0].querySelectorAll("button")).find(b => b.textContent === "Abstract")!;
    const panel = cards[0].querySelector(".result-abstract") as HTMLElement;
    expect(panel.hidden).toBe(true);
    btn.click();
    expect(panel.hidden).toBe(false);
    await vi.waitFor(() => expect(panel.textContent).toBe("Lazy"));
    expect(btn.textContent).toBe("Hide abstract");
    btn.click();
    expect(panel.hidden).toBe(true);
    btn.click();
    expect(fetchJSON).toHaveBeenCalledTimes(1);
  });
});
