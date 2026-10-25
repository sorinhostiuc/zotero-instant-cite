type ResetOptions = {
  clearResults: (doc: Document) => void;
  updateSourceTabs?: (doc: Document, counts: Record<string, number>, total: number) => void;
};

export const ADVANCED_FIELD_IDS = ["adv-title", "adv-author", "adv-identifier", "adv-type", "adv-year"];

/** Empty the advanced search fields, leaving the panel open or closed as it was. */
export function clearAdvancedFields(doc: Document) {
  for (const id of ADVANCED_FIELD_IDS) {
    const el = doc.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (el) el.value = "";
  }
  doc.getElementById("advanced-toggle")?.classList.remove("active");
}

export function resetCitationDialogSurface(doc: Document, options: ResetOptions) {
  const existingContainer = doc.getElementById("existing-items-container");
  if (existingContainer) existingContainer.remove();

  options.clearResults(doc);
  options.updateSourceTabs?.(doc, {}, 0);

  const searchInput = doc.getElementById("search-input") as HTMLInputElement | null;
  if (searchInput) searchInput.value = "";
  clearAdvancedFields(doc);

  const resultsCount = doc.getElementById("results-count");
  if (resultsCount) resultsCount.textContent = "";

  const citeBtn = doc.getElementById("add-cite-btn") as HTMLElement | null;
  if (citeBtn) {
    citeBtn.textContent = "Cite Selected";
    citeBtn.style.pointerEvents = "";
    citeBtn.style.color = "";
  }
}
