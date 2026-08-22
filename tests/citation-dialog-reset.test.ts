import { describe, expect, it, vi } from "vitest";
import { resetCitationDialogSurface } from "../src/modules/citation-dialog-reset";

function createFakeElement(props: Record<string, any> = {}) {
  return {
    textContent: "",
    value: "",
    style: {
      pointerEvents: "none",
      color: "#d32f2f",
    },
    remove: vi.fn(),
    ...props,
  };
}

describe("citation-dialog-reset", () => {
  it("clears old citation UI so a reused dialog starts a fresh search", () => {
    const existingItems = createFakeElement();
    const results = createFakeElement({ textContent: "old search result" });
    const searchInput = createFakeElement({ value: "old query" });
    const resultsCount = createFakeElement({ textContent: "12 results" });
    const citeButton = createFakeElement({ textContent: "Citing..." });
    const elements = new Map<string, any>([
      ["existing-items-container", existingItems],
      ["results-container", results],
      ["search-input", searchInput],
      ["results-count", resultsCount],
      ["add-cite-btn", citeButton],
    ]);
    const doc = {
      getElementById: vi.fn((id: string) => elements.get(id) ?? null),
    };
    const clearResults = vi.fn((d: any) => {
      d.getElementById("results-container").textContent = "";
    });
    const updateSourceTabs = vi.fn();

    resetCitationDialogSurface(doc as any, { clearResults, updateSourceTabs });

    expect(existingItems.remove).toHaveBeenCalledTimes(1);
    expect(results.textContent).toBe("");
    expect(searchInput.value).toBe("");
    expect(resultsCount.textContent).toBe("");
    expect(citeButton.textContent).toBe("Cite Selected");
    expect(citeButton.style.pointerEvents).toBe("");
    expect(citeButton.style.color).toBe("");
    expect(updateSourceTabs).toHaveBeenCalledWith(doc, {}, 0);
  });
});
