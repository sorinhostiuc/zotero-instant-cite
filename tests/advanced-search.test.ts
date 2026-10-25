import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCombinedQuery,
  buildFieldedQuery,
  hasAdvancedFields,
  matchesAdvanced,
  parseYearRange,
  primaryAuthorTerm,
  sourcesForType,
} from "../src/modules/utils/advanced-search";
import { detectQueryType, normalizeISBN } from "../src/modules/utils/query-detector";
import { redactSecrets } from "../src/modules/api/base-client";
import { resolveAdvancedOptions } from "../src/modules/search-orchestrator";
import type { PaperResult } from "../src/modules/api/types";

const { fetchJSON } = vi.hoisted(() => ({ fetchJSON: vi.fn() }));
vi.mock("../src/modules/api/base-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/api/base-client")>()),
  fetchJSON,
}));

function paper(overrides: Partial<PaperResult>): PaperResult {
  return {
    id: "x",
    title: "Medical malpractice in forensic practice",
    authors: [{ name: "Sorin Hostiuc" }, { name: "Maria Pop" }],
    year: 2019,
    isOpenAccess: false,
    sources: ["CrossRef"],
    ...overrides,
  } as PaperResult;
}

describe("ISBN detection", () => {
  it("accepts ISBN-13 and ISBN-10 with hyphens, spaces or a label", () => {
    expect(normalizeISBN("978-3-0365-4193-8")).toBe("9783036541938");
    expect(normalizeISBN("ISBN 0-306-40615-2")).toBe("0306406152");
    expect(normalizeISBN("isbn: 978 0 14 032872 1")).toBe("9780140328721");
  });

  it("rejects a wrong checksum", () => {
    expect(normalizeISBN("9783036541939")).toBeNull();
    expect(normalizeISBN("0306406153")).toBeNull();
  });

  it("is detected as an ISBN query, while PMIDs stay PMIDs", () => {
    expect(detectQueryType("978-3-0365-4193-8")).toEqual({ type: "ISBN", value: "9783036541938" });
    expect(detectQueryType("36789012")).toEqual({ type: "PMID", value: "36789012" });
  });
});

describe("advanced search helpers", () => {
  it("parses single years, ranges and open ranges", () => {
    expect(parseYearRange("2020")).toEqual({ yearFrom: 2020, yearTo: 2020 });
    expect(parseYearRange("2015-2020")).toEqual({ yearFrom: 2015, yearTo: 2020 });
    expect(parseYearRange("2020 - 2015")).toEqual({ yearFrom: 2015, yearTo: 2020 });
    expect(parseYearRange("2015-")).toEqual({ yearFrom: 2015, yearTo: undefined });
    expect(parseYearRange("-2020")).toEqual({ yearFrom: undefined, yearTo: 2020 });
    expect(parseYearRange("last year")).toBeNull();
    expect(parseYearRange("")).toBeNull();
  });

  it("treats a type or text alone differently from fielded input", () => {
    expect(hasAdvancedFields(undefined)).toBe(false);
    expect(hasAdvancedFields({ title: "  " })).toBe(false);
    expect(hasAdvancedFields({ itemType: "book" })).toBe(true);
    expect(buildCombinedQuery("ethics", { title: "malpractice", author: "Hostiuc" }))
      .toBe("ethics malpractice Hostiuc");
  });

  it("requires every title term in the title, accent-insensitively", () => {
    const options = { query: "", fields: { title: "malpraxis" } };
    expect(matchesAdvanced(paper({ title: "Malpraxisul medical" }), options)).toBe(true);
    expect(matchesAdvanced(paper({ title: "Răspunderea medicală" }), options)).toBe(false);
    expect(matchesAdvanced(paper({ title: "Răspunderea medicală" }),
      { query: "", fields: { title: "raspunderea" } })).toBe(true);
  });

  it("matches all author terms against one person", () => {
    const options = { query: "", fields: { author: "Pop Sorin" } };
    expect(matchesAdvanced(paper({}), options)).toBe(false);
    // Single-letter initials are not checked, so "Hostiuc S" still finds Sorin Hostiuc.
    expect(matchesAdvanced(paper({}), { query: "", fields: { author: "Hostiuc S" } })).toBe(true);
    expect(matchesAdvanced(paper({}), { query: "", fields: { author: "hostiuc sorin" } })).toBe(true);
  });

  it("filters by document type and year, keeping undated records", () => {
    const book = paper({ itemType: "book" });
    const thesis = paper({ itemType: "thesis" });
    const article = paper({});
    expect(matchesAdvanced(book, { query: "", fields: { itemType: "book" } })).toBe(true);
    expect(matchesAdvanced(paper({ isbn: "9783036541938" }), { query: "", fields: { itemType: "book" } })).toBe(true);
    expect(matchesAdvanced(article, { query: "", fields: { itemType: "book" } })).toBe(false);
    expect(matchesAdvanced(thesis, { query: "", fields: { itemType: "thesis" } })).toBe(true);
    expect(matchesAdvanced(article, { query: "", fields: { itemType: "article" } })).toBe(true);
    expect(matchesAdvanced(paper({ itemType: "case" }), { query: "", fields: { itemType: "legal" } })).toBe(true);

    const range = { query: "", fields: {}, yearFrom: 2020, yearTo: 2022 };
    expect(matchesAdvanced(article, range)).toBe(false);
    expect(matchesAdvanced(paper({ year: 2021 }), range)).toBe(true);
    expect(matchesAdvanced(paper({ year: 0 }), range)).toBe(true);
  });

  it("prunes the source list to the sources holding the requested type", () => {
    const enabled = ["Zotero", "PubMed", "CrossRef", "OpenLibrary", "ECHR"];
    expect([...sourcesForType(enabled, "book")]).toEqual(["Zotero", "CrossRef", "OpenLibrary"]);
    expect([...sourcesForType(enabled, "legal")]).toEqual(["Zotero", "ECHR"]);
    expect([...sourcesForType(enabled)]).toEqual(enabled);
  });

  it("builds tagged queries for engines with field syntax", () => {
    expect(primaryAuthorTerm("S. Hostiuc")).toBe("Hostiuc");
    const query = buildFieldedQuery(
      { text: "ethics", title: "informed \"consent\"", author: "Hostiuc S" },
      { title: w => `${w}[ti]`, author: w => `${w}[au]` },
    );
    expect(query).toBe("ethics AND informed[ti] AND consent[ti] AND Hostiuc[au]");
  });
});

describe("resolveAdvancedOptions", () => {
  it("lets an identifier win over the other fields", () => {
    const resolved = resolveAdvancedOptions({
      query: "ignored",
      fields: { identifier: " 10.1234/abc ", title: "x", itemType: "book" },
    });
    expect(resolved.query).toBe("10.1234/abc");
    expect(resolved.fields).toBeUndefined();
  });

  it("combines the text and keeps the free text apart for fielded engines", () => {
    const resolved = resolveAdvancedOptions({
      query: "ethics",
      sources: ["Zotero", "PubMed", "OpenLibrary"],
      fields: { title: "consent", author: "Hostiuc", itemType: "book" },
    });
    expect(resolved.query).toBe("ethics consent Hostiuc");
    expect(resolved.fields?.text).toBe("ethics");
    expect(resolved.sources).toEqual(["Zotero", "OpenLibrary"]);
  });
});

describe("source query building", () => {
  const prefs = new Map<string, unknown>();

  beforeEach(() => {
    prefs.clear();
    fetchJSON.mockReset();
    fetchJSON.mockResolvedValue({ results: [], items: [], message: { items: [] }, meta: { count: 0 } });
    vi.stubGlobal("Zotero", {
      log: () => {},
      Prefs: { get: (name: string) => prefs.get(name.split(".").pop()!) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends OpenAlex fielded filters and the optional API key", async () => {
    const { searchOpenAlex } = await import("../src/modules/api/openalex");
    prefs.set("openAlexApiKey", " secret123 ");
    await searchOpenAlex({
      query: "ethics consent Hostiuc",
      yearFrom: 2018,
      yearTo: 2022,
      fields: { text: "ethics", title: "consent", author: "Hostiuc", itemType: "thesis" },
    });
    const url = new URL(fetchJSON.mock.calls[0][0] as string);
    expect(url.searchParams.get("search")).toBe("ethics");
    expect(url.searchParams.get("filter")).toBe(
      "title.search:consent,raw_author_name.search:Hostiuc,type:dissertation,publication_year:2018-2022");
    expect(url.searchParams.get("api_key")).toBe("secret123");
  });

  it("leaves the OpenAlex key out when none is set", async () => {
    const { searchOpenAlex } = await import("../src/modules/api/openalex");
    await searchOpenAlex({ query: "malpractice" });
    const url = new URL(fetchJSON.mock.calls[0][0] as string);
    expect(url.searchParams.get("search")).toBe("malpractice");
    expect(url.searchParams.has("api_key")).toBe(false);
  });

  it("maps OpenAlex books, chapters and theses to Zotero types", async () => {
    const { parseOpenAlexResults } = await import("../src/modules/api/openalex");
    const results = parseOpenAlexResults({
      results: [
        { id: "https://openalex.org/W1", title: "A book", type: "book", ids: { isbn: ["9783036541938"] },
          primary_location: { source: { display_name: "Series", host_organization_name: "Springer" } } },
        { id: "https://openalex.org/W2", title: "A chapter", type: "book-chapter",
          primary_location: { source: { display_name: "The Handbook" } } },
        { id: "https://openalex.org/W3", title: "A thesis", type: "dissertation",
          primary_location: { source: { display_name: "Repository", host_organization_name: "UMFCD" } } },
        { id: "https://openalex.org/W4", title: "A paper", type: "article",
          primary_location: { source: { display_name: "Journal" } } },
      ],
    });
    expect(results.map(r => r.itemType)).toEqual(["book", "bookSection", "thesis", undefined]);
    expect(results[0]).toMatchObject({ isbn: "9783036541938", journal: "", publisher: "Springer" });
    expect(results[1].journal).toBe("The Handbook");
    expect(results[2]).toMatchObject({ journal: "", publisher: "UMFCD" });
    expect(results[3].journal).toBe("Journal");
  });

  it("uses the CrossRef ISBN filter, fielded params and ORed type filters", async () => {
    const { searchCrossRef } = await import("../src/modules/api/crossref");
    await searchCrossRef({ query: "978-3-0365-4193-8" });
    let url = new URL(fetchJSON.mock.calls[0][0] as string);
    expect(url.searchParams.get("filter")).toBe("isbn:9783036541938");
    expect(url.searchParams.has("query")).toBe(false);

    await searchCrossRef({
      query: "consent Hostiuc",
      yearFrom: 2019,
      fields: { title: "consent", author: "Hostiuc", itemType: "chapter" },
    });
    url = new URL(fetchJSON.mock.calls[1][0] as string);
    expect(url.searchParams.get("query.bibliographic")).toBe("consent");
    expect(url.searchParams.get("query.author")).toBe("Hostiuc");
    expect(url.searchParams.get("filter")).toBe(
      "type:book-chapter,type:book-section,type:book-part,type:reference-entry,from-pub-date:2019");
  });
});

describe("redactSecrets", () => {
  it("masks key-like URL parameters only", () => {
    expect(redactSecrets("https://api.openalex.org/works?search=x&api_key=abc123&per_page=5"))
      .toBe("https://api.openalex.org/works?search=x&api_key=***&per_page=5");
    expect(redactSecrets("GET https://x.org/?token=t0k \"failed\"")).toBe("GET https://x.org/?token=*** \"failed\"");
    expect(redactSecrets("https://x.org/?keyword=abc")).toBe("https://x.org/?keyword=abc");
  });
});
