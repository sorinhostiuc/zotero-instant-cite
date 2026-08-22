type ResetOptions = {
  clearResults: (doc: Document) => void;
  updateSourceTabs?: (doc: Document, counts: Record<string, number>, total: number) => void;
};

export function resetCitationDialogSurface(doc: Document, options: ResetOptions) {
  const existingContainer = doc.getElementById("existing-items-container");
  if (existingContainer) existingContainer.remove();

  options.clearResults(doc);
  options.updateSourceTabs?.(doc, {}, 0);

  const searchInput = doc.getElementById("search-input") as HTMLInputElement | null;
  if (searchInput) searchInput.value = "";

  const resultsCount = doc.getElementById("results-count");
  if (resultsCount) resultsCount.textContent = "";

  const citeBtn = doc.getElementById("add-cite-btn") as HTMLElement | null;
  if (citeBtn) {
    citeBtn.textContent = "Cite Selected";
    citeBtn.style.pointerEvents = "";
    citeBtn.style.color = "";
  }
}
