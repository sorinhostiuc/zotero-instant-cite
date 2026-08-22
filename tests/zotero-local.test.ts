import { describe, expect, it, vi } from "vitest";
import { addQueryCondition, selectLocalSearchItemIds } from "../src/modules/api/zotero-local";

describe("addQueryCondition", () => {
  const fakeSearch = () => ({ addCondition: vi.fn() });

  it("matches a DOI query against the DOI field", () => {
    const search = fakeSearch();
    addQueryCondition(search, "https://doi.org/10.3390/medicina62020293");
    expect(search.addCondition).toHaveBeenCalledWith("DOI", "contains", "10.3390/medicina62020293");
  });

  it("matches a PMID query against Extra", () => {
    const search = fakeSearch();
    addQueryCondition(search, "40123456");
    expect(search.addCondition).toHaveBeenCalledWith("extra", "contains", "40123456");
  });

  it("uses quicksearch for keyword queries", () => {
    const search = fakeSearch();
    addQueryCondition(search, "brain injury biomarkers");
    expect(search.addCondition).toHaveBeenCalledWith(
      "quicksearch-titleCreatorYear", "contains", "brain injury biomarkers");
  });

  it("falls back to quicksearch when the field condition is unsupported", () => {
    const search = {
      addCondition: vi.fn((field: string) => {
        if (field === "DOI") throw new Error("Invalid search condition");
      }),
    };
    addQueryCondition(search, "10.3390/medicina62020293");
    expect(search.addCondition).toHaveBeenLastCalledWith(
      "quicksearch-titleCreatorYear", "contains", "10.3390/medicina62020293");
  });
});

describe("selectLocalSearchItemIds", () => {
  it("limits first, then prioritizes cited items inside the preserved window", () => {
    const itemIds = Array.from({ length: 120 }, (_, i) => i + 1);
    const prioritized = new Set([110, 111, 112]);

    const result = selectLocalSearchItemIds(itemIds, prioritized, 100);

    expect(result).toHaveLength(100);
    expect(result).toContain(100);
    expect(result).not.toContain(110);
    expect(result).not.toContain(120);
  });

  it("moves prioritized items to the front when they are inside the preserved window", () => {
    const itemIds = [7, 8, 9, 10, 11];
    const prioritized = new Set([10, 8]);

    const result = selectLocalSearchItemIds(itemIds, prioritized, 5);

    expect(result.slice(0, 2)).toEqual([8, 10]);
    expect(result).toEqual([8, 10, 7, 9, 11]);
  });
});
