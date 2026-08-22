import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/api/crossref", () => ({
  lookupCrossRefDOI: vi.fn(),
  searchCrossRef: vi.fn(),
}));
vi.mock("../src/modules/api/europepmc", () => ({
  searchEuropePMC: vi.fn(),
}));
vi.mock("../src/modules/api/pubmed", () => ({
  searchPubMed: vi.fn(),
}));
vi.mock("../src/modules/api/open-library", () => ({
  searchOpenLibrary: vi.fn(),
}));
vi.mock("../src/modules/api/google-books", () => ({
  searchGoogleBooks: vi.fn(),
}));

import { lookupCrossRefDOI, searchCrossRef } from "../src/modules/api/crossref";
import { searchEuropePMC } from "../src/modules/api/europepmc";
import { updateSingleItem } from "../src/modules/item-updater";

type FieldMap = Record<string, string>;

const validFieldsByType: Record<string, Set<string>> = {
  journalArticle: new Set([
    "DOI", "title", "date", "publicationTitle", "volume", "issue",
    "pages", "ISSN", "journalAbbreviation", "abstractNote", "extra",
  ]),
  book: new Set([
    "DOI", "ISBN", "title", "date", "publisher", "place", "edition",
    "numPages", "abstractNote", "extra",
  ]),
  case: new Set(["title", "date", "caseName", "court", "reporter", "extra"]),
};

function installZoteroMock() {
  (globalThis as any).Zotero = {
    ItemTypes: {
      getName: (id: string) => id,
      getID: (name: string) => name,
    },
  };
}

function createItem(itemType: string, fields: FieldMap = {}) {
  let type = itemType;
  const savedFields: FieldMap = { ...fields };
  const saveTx = vi.fn(async () => undefined);
  const setType = vi.fn((newType: string) => { type = newType; item.itemTypeID = newType; });
  const item = {
    itemTypeID: itemType,
    getField: vi.fn((field: string) => {
      if (!validFieldsByType[type]?.has(field)) {
        throw new Error(`Invalid field '${field}' for ${type}`);
      }
      return savedFields[field] || "";
    }),
    setField: vi.fn((field: string, value: string) => {
      if (!validFieldsByType[type]?.has(field)) {
        throw new Error(`Invalid field '${field}' for ${type}`);
      }
      savedFields[field] = value;
    }),
    getCreators: vi.fn(() => []),
    setCreator: vi.fn(),
    setType,
    saveTx,
    getSavedFields: () => savedFields,
  };
  return item;
}

describe("updateSingleItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installZoteroMock();
    vi.mocked(lookupCrossRefDOI).mockResolvedValue({
      source: "CrossRef",
      results: [],
      totalCount: 0,
      searchTimeMs: 0,
    });
    vi.mocked(searchCrossRef).mockResolvedValue({
      source: "CrossRef",
      results: [],
      totalCount: 0,
      searchTimeMs: 0,
    });
    vi.mocked(searchEuropePMC).mockResolvedValue({
      source: "EuropePMC",
      results: [],
      totalCount: 0,
      searchTimeMs: 0,
    });
  });

  it("does not throw when the current item type does not support DOI or ISBN", async () => {
    const item = createItem("case", { title: "Example case" });

    await expect(updateSingleItem(item)).resolves.toContain("No DOI, ISBN, or PMID found in this item");

    expect(item.saveTx).not.toHaveBeenCalled();
  });

  it("changes the Zotero item type before applying fields from matched metadata", async () => {
    vi.mocked(lookupCrossRefDOI).mockResolvedValue({
      source: "CrossRef",
      totalCount: 1,
      searchTimeMs: 1,
      results: [{
        id: "crossref:10.1234/book",
        title: "Matched Book",
        authors: [],
        year: 2024,
        doi: "10.1234/book",
        itemType: "book",
        publisher: "Example Press",
        place: "Bucharest",
        isOpenAccess: false,
        sources: ["CrossRef"],
      }],
    });
    const item = createItem("journalArticle", { DOI: "10.1234/book", date: "" });

    const result = await updateSingleItem(item);

    expect(item.setType).toHaveBeenCalledWith("book");
    expect(item.getSavedFields().publisher).toBe("Example Press");
    expect(item.getSavedFields().place).toBe("Bucharest");
    expect(item.saveTx).toHaveBeenCalledTimes(1);
    expect(result).toContain("Updated from CrossRef");
    expect(result).toContain("± itemType: journalArticle → book");
  });

  it("applies nothing when the DOI resolves to a different article", async () => {
    vi.mocked(lookupCrossRefDOI).mockResolvedValue({
      source: "CrossRef",
      totalCount: 1,
      searchTimeMs: 1,
      results: [{
        id: "crossref:10.1016/j.pec.2021.05.032",
        title: "Shared decision-making in oncology consultations",
        authors: [],
        year: 2021,
        journal: "Patient Education and Counseling",
        volume: "104",
        pages: "1123-1131",
        doi: "10.1016/j.pec.2021.05.032",
        isOpenAccess: false,
        sources: ["CrossRef"],
      }],
    });
    const item = createItem("journalArticle", {
      DOI: "10.1016/j.pec.2021.05.032",
      title: "Non-Surgical Causes of Death in the Emergency Department: A Five-Year Monocentric Clinicopathological Study",
      publicationTitle: "Medicina",
    });

    const result = await updateSingleItem(item);

    expect(item.saveTx).not.toHaveBeenCalled();
    expect(item.getSavedFields().publicationTitle).toBe("Medicina");
    expect(item.getSavedFields().volume).toBeUndefined();
    expect(result[0]).toContain("Identifier mismatch");
  });

  it("replaces a wrong DOI when the title search identifies the real article", async () => {
    vi.mocked(searchCrossRef).mockResolvedValue({
      source: "CrossRef",
      totalCount: 1,
      searchTimeMs: 1,
      results: [{
        id: "crossref:10.3390/medicina62020293",
        title: "Non-Surgical Causes of Death in the Emergency Department: A Five-Year Monocentric Clinicopathological Study",
        authors: [],
        year: 2026,
        journal: "Medicina",
        volume: "62",
        issue: "2",
        pages: "293",
        doi: "10.3390/medicina62020293",
        isOpenAccess: true,
        sources: ["CrossRef"],
      }],
    });
    const item = createItem("journalArticle", {
      // Truncated reference-list DOI — never a usable identifier
      DOI: "10.1016/j.pec.2021.",
      title: "Non-Surgical Causes of Death in the Emergency Department: A Five-Year Monocentric Clinicopathological Study",
    });

    const result = await updateSingleItem(item);

    expect(lookupCrossRefDOI).not.toHaveBeenCalled();
    expect(item.getSavedFields().DOI).toBe("10.3390/medicina62020293");
    expect(item.getSavedFields().volume).toBe("62");
    expect(result.join(" ")).toContain("± DOI");
  });
});
