import { orchestrateSearch, type OrchestratedResult } from "./search-orchestrator";
import { searchZoteroLocal } from "./api/zotero-local";
import { renderResults, clearResults, updateSourceTabs, showLoading, hideLoading } from "./result-renderer";
import { addToZotero, downloadAndOpenPDF, openPaperOrPDF } from "./zotero-bridge";
import { openSettingsDialog } from "./settings-dialog";
import {
  getDisabledSources, setDisabledSources,
  getDefaultSort, getDefaultSortDir,
  isLocalSearchEnabled, getMaxResults,
  getAutoUpdateMode,
  getSearchDialogWindowSize,
} from "./preferences";
import { findAndMergeUpdates, applyAutoUpdates, showPreviewModal } from "./auto-updater";
import { openMergeDialog } from "./dedup-dialog";
import { documentItemIds, loadDocumentItemIdsFromCitationIO } from "./integration-patch";
import {
  clearPersistentDialogWindow,
  getPersistentDialogWindow,
  openFreshDialogWindow,
  openOrReuseDialogWindow,
} from "./dialog-window-manager";
import { resetCitationDialogSurface } from "./citation-dialog-reset";
import { sortByProvenance } from "./utils/document-priority";
import type { SearchOptions, PaperResult } from "./api/types";

/** Per-citation properties (locator, prefix, suffix, etc.) */
interface CitationProps {
  locator: string;
  label: string;
  prefix: string;
  suffix: string;
  suppressAuthor: boolean;
}

let currentResults: OrchestratedResult | null = null;
let selectedPapers: Map<string, PaperResult> = new Map();
let citationPropsMap: Map<string, CitationProps> = new Map();
let activeFilter: string = "all";
let localSearchTimer: ReturnType<typeof setTimeout> | null = null;
let documentItemIdsLoadTimer: ReturnType<typeof setTimeout> | null = null;
let existingCitationLoadTimer: ReturnType<typeof setTimeout> | null = null;
let isFullSearchDone = false;
let currentSortField = "relevance";
let currentSortDir: "asc" | "desc" = "desc";

// Integration callbacks (module-level so closures always see current values)
let integrationAcceptCb: ((items: Array<Record<string, any>>) => void) | null = null;
let integrationCancelCb: (() => void) | null = null;
let integrationIO: any = null;

type MainWindowWithOpenDialog = Window & { openDialog: (...args: any[]) => Window };
type IntegrationCommandWindow = {
  closed: boolean;
  isPristine: boolean;
  focus: () => void;
  close: () => void;
  cancel: () => void;
  _instantCiteDialogWindow: Window;
};

function clearIntegrationState() {
  integrationAcceptCb = null;
  integrationCancelCb = null;
  integrationIO = null;
}

function cancelActiveIntegration() {
  const cancel = integrationCancelCb;
  clearIntegrationState();
  if (cancel) cancel();
}

function clearExistingCitationLoadTimer() {
  if (existingCitationLoadTimer) {
    clearTimeout(existingCitationLoadTimer);
    existingCitationLoadTimer = null;
  }
}

/** Close the dialog window */
function clearDialogTimers() {
  if (documentItemIdsLoadTimer) {
    clearTimeout(documentItemIdsLoadTimer);
    documentItemIdsLoadTimer = null;
  }
  clearExistingCitationLoadTimer();
}

function closeDialogWindow(win: Window, options: { cancelIntegration?: boolean } = {}) {
  clearDialogTimers();
  if (options.cancelIntegration !== false && integrationCancelCb) cancelActiveIntegration();
  clearPersistentDialogWindow(win);
  clearZoteroIntegrationWindow(win);
  win.close();
}

function resetPersistentDialogForIdle(win: Window) {
  try {
    if ((win as any)._instantCiteInitialized) {
      resetCitationDialogSurface(win.document, { clearResults, updateSourceTabs });
      updateSelectionCount(win.document);
      if ((win as any)._instantCitePendingCitation) {
        setPendingCitationUi(win.document);
      }
    }
  } catch { /* ignore */ }
}

function setPendingCitationUi(doc: Document) {
  const citeBtn = doc.getElementById("add-cite-btn") as HTMLElement | null;
  if (citeBtn) {
    citeBtn.textContent = "Preparing citation...";
    citeBtn.style.pointerEvents = "none";
    citeBtn.style.color = "#5f6368";
    citeBtn.title = "Waiting for Word citation session";
  }
}

function clearZoteroIntegrationWindow(target: Window | IntegrationCommandWindow) {
  try {
    const integration = (Zotero as any).Integration;
    const current = integration?.currentWindow;
    if (
      current === target ||
      current?._instantCiteDialogWindow === target ||
      (target as IntegrationCommandWindow)._instantCiteDialogWindow === current
    ) {
      integration.currentWindow = false;
    }
  } catch { /* ignore */ }
}

function createIntegrationCommandWindow(win: Window): IntegrationCommandWindow {
  const previous = (win as any)._instantCiteCommandWindow as IntegrationCommandWindow | undefined;
  if (previous) previous.closed = true;

  const commandWindow: IntegrationCommandWindow = {
    closed: false,
    isPristine: true,
    _instantCiteDialogWindow: win,
    focus: () => {
      try { win.focus(); } catch { /* ignore */ }
    },
    close: () => {
      commandWindow.closed = true;
      clearDialogTimers();
      clearZoteroIntegrationWindow(commandWindow);
      clearPersistentDialogWindow(win);
      try {
        if (!(win as any).closed) win.close();
      } catch { /* ignore */ }
    },
    cancel: () => {
      if (!commandWindow.closed) commandWindow.closed = true;
      if (integrationCancelCb) cancelActiveIntegration();
      clearDialogTimers();
      clearZoteroIntegrationWindow(commandWindow);
      clearPersistentDialogWindow(win);
      try {
        if (!(win as any).closed) win.close();
      } catch { /* ignore */ }
    },
  };

  (win as any)._instantCiteCommandWindow = commandWindow;
  (win as any).cancel = commandWindow.cancel;
  return commandWindow;
}

function registerZoteroIntegrationWindow(win: Window) {
  const integration = (Zotero as any).Integration;
  if (!integration) return;

  const commandWindow = createIntegrationCommandWindow(win);
  integration.currentWindow = commandWindow;
  integration.currentWindowType = "citation";
  (win as any).isPristine = true;
}

function attachCitationSession(win: Window, existingItems: any[]) {
  const doc = win.document;
  const wasPreparedForPendingCitation = (win as any)._instantCitePendingCitation === true;
  (win as any)._instantCitePendingCitation = false;
  clearExistingCitationLoadTimer();

  if (!wasPreparedForPendingCitation) {
    currentResults = null;
    selectedPapers = new Map();
    citationPropsMap = new Map();
    activeFilter = "all";
    isFullSearchDone = false;
    resetCitationDialogSurface(doc, { clearResults, updateSourceTabs });
  }

  const addCiteBtn = doc.getElementById("add-cite-btn");
  if (addCiteBtn) {
    addCiteBtn.textContent = existingItems.length > 0 ? "Update Citation" : "Cite Selected";
    (addCiteBtn as HTMLElement).style.pointerEvents = "";
    (addCiteBtn as HTMLElement).style.color = "";
    (addCiteBtn as HTMLElement).title = "";
  }

  if (existingItems.length > 0) {
    const sessionIO = integrationIO;
    existingCitationLoadTimer = setTimeout(() => {
      existingCitationLoadTimer = null;
      if (!sessionIO || integrationIO !== sessionIO) return;
      loadExistingCitationItems(win, doc, sessionIO, existingItems);
    }, 0);
  } else {
    updateSelectionCount(doc);
  }

  if (integrationIO) {
    loadDocumentItemIdsFromCitationIO(integrationIO, { waitForFullScan: false });
    scheduleDocumentItemIdsRefresh(win, doc, integrationIO);
  }

  const searchInput = doc.getElementById("search-input") as HTMLInputElement | null;
  searchInput?.focus();
}

function resetDialogAfterSuccessfulCitation(win: Window) {
  (win as any)._instantCitePendingCitation = false;
  clearDialogTimers();
  currentResults = null;
  selectedPapers = new Map();
  citationPropsMap = new Map();
  activeFilter = "all";
  isFullSearchDone = false;
  resetCitationDialogSurface(win.document, { clearResults, updateSourceTabs });
  updateSelectionCount(win.document);
}

export function prepareSearchDialogForPendingCitation(): boolean {
  const win = getPersistentDialogWindow();
  if (!win) return false;

  closeDialogWindow(win, { cancelIntegration: false });
  return true;
}

/** Open dialog in standalone mode (from Zotero menu / keyboard shortcut) */
export function openSearchDialog() {
  const mainWindow = Zotero.getMainWindow();
  if (!mainWindow) return;

  // Clear integration state (standalone mode)
  clearIntegrationState();

  const win = openOrReuseDialogWindow(mainWindow as MainWindowWithOpenDialog, initDialogEvents);
  if ((win as any)._instantCiteInitialized) {
    const addCiteBtn = win.document.getElementById("add-cite-btn") as HTMLElement | null;
    if (addCiteBtn) {
      addCiteBtn.textContent = "Add & Cite";
      addCiteBtn.style.pointerEvents = "";
      addCiteBtn.style.color = "";
    }
    updateSelectionCount(win.document);
  }
}

/**
 * Open dialog for Word citation integration.
 * Called from integration-patch instead of opening a dialog directly.
 */
export function openSearchDialogForCitation(
  io: any,
  existingItems: any[],
  onAccept: (items: Array<Record<string, any>>) => void,
  onCancel: () => void,
) {
  const mainWindow = Zotero.getMainWindow();
  if (!mainWindow) { onCancel(); return; }

  const win = openFreshDialogWindow(mainWindow as MainWindowWithOpenDialog, initDialogEvents);

  // Set integration state
  integrationIO = io;
  integrationAcceptCb = onAccept;
  integrationCancelCb = onCancel;

  registerZoteroIntegrationWindow(win);
  (win as any)._instantCiteExistingItems = existingItems;
  if ((win as any)._instantCiteInitialized) attachCitationSession(win, existingItems);
}

function initDialogEvents(win: Window) {
  (win as any)._instantCiteInitialized = true;
  const doc = win.document;

  // Reset state
  currentResults = null;
  selectedPapers = new Map();
  citationPropsMap = new Map();
  activeFilter = "all";
  isFullSearchDone = false;
  if (localSearchTimer) { clearTimeout(localSearchTimer); localSearchTimer = null; }
  if (documentItemIdsLoadTimer) { clearTimeout(documentItemIdsLoadTimer); documentItemIdsLoadTimer = null; }
  clearExistingCitationLoadTimer();
  updateSelectionCount(doc);

  // Restore saved source checkbox selections from preferences
  restoreSourceSelections(doc);

  // Apply default sort from preferences
  currentSortField = getDefaultSort();
  currentSortDir = getDefaultSortDir();
  doc.querySelectorAll(".sort-btn").forEach(btn => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.sort === currentSortField);
  });
  const dirBtn = doc.getElementById("sort-dir-btn") as HTMLElement;
  if (dirBtn) {
    dirBtn.dataset.dir = currentSortDir;
    dirBtn.textContent = currentSortDir === "desc" ? "\u25BC" : "\u25B2";
    dirBtn.title = currentSortDir === "desc" ? "Descending" : "Ascending";
  }

  // If the dialog was opened by the Word integration, attach that active session.
  if (integrationIO) {
    const existingItems = (win as any)._instantCiteExistingItems ?? [];
    attachCitationSession(win, existingItems);
  }

  // Safety net: if the window is closed externally (X button, Alt+F4),
  // ensure integration callbacks are cleaned up so Zotero doesn't hang.
  win.addEventListener("unload", () => {
    if (win.location?.toString() === "about:blank") return;
    if (integrationCancelCb) cancelActiveIntegration();
    clearPersistentDialogWindow(win);
    clearZoteroIntegrationWindow(win);
  });

  // Search — focus input immediately for fast UX
  const searchInput = doc.getElementById("search-input") as HTMLInputElement;
  searchInput?.focus();
  doc.getElementById("search-btn")?.addEventListener("click", () => performFullSearch(win));
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") performFullSearch(win);
  });

  // Debounced local search — instant results from My Library as user types
  searchInput?.addEventListener("input", () => {
    isFullSearchDone = false; // New typing resets full search state
    if (!isLocalSearchEnabled()) return; // Disabled in settings
    if (localSearchTimer) clearTimeout(localSearchTimer);
    localSearchTimer = setTimeout(() => {
      performLocalSearch(win);
    }, 500);
  });

  // Close / Cancel
  const closeDialog = () => {
    closeDialogWindow(win);
  };
  doc.getElementById("close-btn")?.addEventListener("click", closeDialog);
  doc.getElementById("cancel-btn")?.addEventListener("click", closeDialog);

  // Add to Library only (no cite) — works in both modes
  doc.getElementById("add-library-btn")?.addEventListener("click", () => {
    addSelectedToLibrary(doc);
  });

  // Merge selected Zotero items — manual override, works only on local items
  doc.getElementById("merge-btn")?.addEventListener("click", () => {
    handleMergeSelected(win, doc);
  });

  // Add & Cite — in integration mode: cite in Word; in standalone: just add to library
  doc.getElementById("add-cite-btn")?.addEventListener("click", () => {
    const btn = doc.getElementById("add-cite-btn") as HTMLElement;
    Zotero.log("[InstantCite] Cite button clicked. integrationIO=" + !!integrationIO
      + " acceptCb=" + !!integrationAcceptCb + " selected=" + selectedPapers.size
      + " pointerEvents=" + (btn?.style.pointerEvents || "auto"));
    if ((win as any)._instantCitePendingCitation && (!integrationIO || !integrationAcceptCb)) {
      Zotero.log("[InstantCite] Cite blocked: Word citation IO is not attached yet");
      setPendingCitationUi(doc);
      return;
    }
    if (integrationIO && integrationAcceptCb) {
      if (selectedPapers.size === 0) {
        if (btn) { btn.textContent = "No papers selected!"; btn.style.color = "#d32f2f"; }
        setTimeout(() => { if (btn) { btn.textContent = "Cite Selected"; btn.style.color = ""; } }, 2000);
        return;
      }
      addAndCiteSelected(win, integrationAcceptCb).catch(err => {
        Zotero.log("[InstantCite] addAndCiteSelected error: " + err);
        if (btn) { btn.textContent = "Retry"; btn.style.pointerEvents = ""; btn.style.color = "#d32f2f"; }
      });
    } else {
      Zotero.log("[InstantCite] Standalone mode — adding to library and closing");
      addSelectedToLibrary(doc);
      closeDialogWindow(win);
    }
  });

  // Source tabs
  doc.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      const source = (e.currentTarget as HTMLElement).dataset.source ?? "all";
      filterBySource(win, source);
    });
  });

  // Sort buttons (preference values already loaded above)
  doc.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const field = (btn as HTMLElement).dataset.sort ?? "relevance";
      doc.querySelectorAll(".sort-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentSortField = field;
      sortResults(win);
    });
  });

  // Sort direction toggle
  doc.getElementById("sort-dir-btn")?.addEventListener("click", () => {
    const dirBtn = doc.getElementById("sort-dir-btn") as HTMLElement;
    if (!dirBtn) return;
    currentSortDir = currentSortDir === "desc" ? "asc" : "desc";
    dirBtn.dataset.dir = currentSortDir;
    dirBtn.textContent = currentSortDir === "desc" ? "\u25BC" : "\u25B2";
    dirBtn.title = currentSortDir === "desc" ? "Descending" : "Ascending";
    sortResults(win);
  });

  // Year filter buttons (Google Scholar style) — filter results client-side
  doc.querySelectorAll(".year-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const wasActive = btn.classList.contains("active");
      doc.querySelectorAll(".year-btn").forEach(b => b.classList.remove("active"));
      if (!wasActive) btn.classList.add("active");
      // Clear custom inputs when clicking a preset
      const fromInput = doc.getElementById("year-from") as HTMLInputElement;
      const toInput = doc.getElementById("year-to") as HTMLInputElement;
      if (fromInput) fromInput.value = "";
      if (toInput) toInput.value = "";
      // Re-filter displayed results
      applyFiltersAndRender(doc);
    });
  });

  // Set dynamic max year on custom range inputs
  const currentYear = String(new Date().getFullYear());
  const yearFrom = doc.getElementById("year-from") as HTMLInputElement;
  const yearTo = doc.getElementById("year-to") as HTMLInputElement;
  if (yearFrom) yearFrom.max = currentYear;
  if (yearTo) yearTo.max = currentYear;
  const onYearInputChange = () => {
    // Clear preset buttons when typing custom range
    doc.querySelectorAll(".year-btn").forEach(b => b.classList.remove("active"));
    applyFiltersAndRender(doc);
  };
  yearFrom?.addEventListener("input", onYearInputChange);
  yearTo?.addEventListener("input", onYearInputChange);

  // Source checkboxes — re-filter results client-side when toggled + persist selection
  doc.querySelectorAll(".source-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => {
      saveSourceSelections(doc);
      applyFiltersAndRender(doc);
    });
  });

  // Open Access filter — re-filter on toggle
  doc.getElementById("oa-filter")?.addEventListener("change", () => {
    applyFiltersAndRender(doc);
  });

  // Settings button (gear icon in footer)
  doc.getElementById("settings-btn")?.addEventListener("click", () => {
    openSettingsDialog(doc, () => {
      const { width, height } = getSearchDialogWindowSize();
      try { (win as any).resizeTo(width, height); } catch { /* ignore */ }
      // After settings saved, re-apply source selections
      restoreSourceSelections(doc);
      // Re-apply sort if changed
      currentSortField = getDefaultSort();
      currentSortDir = getDefaultSortDir();
      doc.querySelectorAll(".sort-btn").forEach(btn => {
        btn.classList.toggle("active", (btn as HTMLElement).dataset.sort === currentSortField);
      });
      const dirBtnEl = doc.getElementById("sort-dir-btn") as HTMLElement;
      if (dirBtnEl) {
        dirBtnEl.dataset.dir = currentSortDir;
        dirBtnEl.textContent = currentSortDir === "desc" ? "\u25BC" : "\u25B2";
      }
      if (currentResults) sortResults(win);
    });
  });

  // Keyboard shortcuts
  win.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDialog();
    if (e.ctrlKey && e.key === "Enter") {
      if ((win as any)._instantCitePendingCitation && (!integrationIO || !integrationAcceptCb)) {
        Zotero.log("[InstantCite] Ctrl+Enter blocked: Word citation IO is not attached yet");
        setPendingCitationUi(doc);
        return;
      }
      if (integrationIO && integrationAcceptCb) {
        addAndCiteSelected(win, integrationAcceptCb).catch(err => {
          Zotero.log("[InstantCite] Ctrl+Enter cite error: " + err);
          const btn = doc.getElementById("add-cite-btn") as HTMLElement;
          if (btn) { btn.textContent = "Retry"; btn.style.pointerEvents = ""; btn.style.color = "#d32f2f"; }
        });
      } else {
        addSelectedToLibrary(doc);
        closeDialogWindow(win);
      }
    }
  });

  searchInput?.focus();
}

function scheduleDocumentItemIdsRefresh(win: Window, doc: Document, io: any) {
  if (documentItemIdsLoadTimer) clearTimeout(documentItemIdsLoadTimer);
  documentItemIdsLoadTimer = setTimeout(() => {
    documentItemIdsLoadTimer = null;
    loadDocumentItemIdsFromCitationIO(io, { waitForFullScan: true }).then((ids) => {
      if ((win as any).closed || ids.size === 0 || !currentResults) return;
      const searchInput = doc.getElementById("search-input") as HTMLInputElement | null;
      const query = searchInput?.value?.trim() ?? "";
      if (!isFullSearchDone && query.length >= 2) {
        performLocalSearch(win);
        return;
      }
      renderCurrentResults(doc);
    });
  }, 1500);
}

/** Load existing citation items when editing an existing citation in Word.
 *  Creates a SEPARATE persistent container above results-container so existing
 *  items remain visible even after the user performs a search. */
function loadExistingCitationItems(win: Window, doc: Document, io: any, existingItemsArg?: any[]) {
  const existingItems = existingItemsArg ?? (win as any)._instantCiteExistingItems ?? io?.citation?.citationItems ?? [];
  Zotero.log("[InstantCite] Existing citation items: " + existingItems.length);
  if (existingItems.length === 0) return;

  const resultsContainer = doc.getElementById("results-container");
  if (!resultsContainer) return;

  // Create a persistent container ABOVE results-container that won't be cleared by searches
  let container = doc.getElementById("existing-items-container");
  if (!container) {
    container = doc.createElement("div");
    container.id = "existing-items-container";
    container.className = "existing-items-container";
    resultsContainer.parentNode!.insertBefore(container, resultsContainer);
  }
  container.textContent = "";

  const header = doc.createElement("div");
  header.className = "existing-citation-header";
  header.textContent = "Current citation (" + existingItems.length + " reference" + (existingItems.length > 1 ? "s" : "") + ") \u2014 uncheck to remove:";
  container.appendChild(header);

  for (const citItem of existingItems) {
    try {
      const itemId = citItem.id ?? citItem.itemID;
      if (!itemId) continue;
      const zoteroItem = Zotero.Items.get(itemId);
      if (!zoteroItem) {
        Zotero.log("[InstantCite] Item not found for id=" + itemId);
        continue;
      }

      const card = doc.createElement("div");
      card.className = "result-card selected existing-item-card";

      const checkbox = doc.createElement("input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.className = "result-checkbox";
      checkbox.checked = true;
      card.appendChild(checkbox);

      const content = doc.createElement("div");
      content.className = "result-content";

      const itemType = zoteroItem.itemType as string;
      const isBook = itemType === "book" || itemType === "bookSection";

      // --- Title ---
      const titleVal = (zoteroItem.getField("title") as string) || "";
      const titleDiv = doc.createElement("div");
      titleDiv.className = "result-title";
      titleDiv.textContent = titleVal || "Untitled";
      content.appendChild(titleDiv);

      // --- Authors (full list) ---
      const creators = zoteroItem.getCreators();
      const authorNames = (creators || [])
        .filter((c: any) => {
          const authorTypeID = Zotero.CreatorTypes.getID("author");
          return c.creatorTypeID === authorTypeID || !c.creatorTypeID;
        })
        .map((c: any) => c.fieldMode === 1 ? c.lastName : (c.firstName ? c.firstName + " " + c.lastName : c.lastName))
        .filter((n: string) => n && n.trim() !== "");
      if (authorNames.length > 0) {
        const authorsDiv = doc.createElement("div");
        authorsDiv.className = "result-authors";
        authorsDiv.textContent = authorNames.join(", ");
        content.appendChild(authorsDiv);
      }

      // --- Full citation fields (read-only display, type-aware) ---
      const date = (zoteroItem.getField("date") as string) || "";
      content.appendChild(renderCitationFieldsBlock(doc, buildCitationFieldsDisplay(zoteroItem)));

      // --- Abstract (visible preview + expandable) ---
      const abstractVal = (zoteroItem.getField("abstractNote") as string) || "";
      if (abstractVal) {
        const PREVIEW_LEN = 200;
        const isLong = abstractVal.length > PREVIEW_LEN;

        const abstractDiv = doc.createElement("div");
        abstractDiv.className = "result-abstract";
        abstractDiv.textContent = isLong
          ? abstractVal.slice(0, PREVIEW_LEN) + "..."
          : abstractVal;
        content.appendChild(abstractDiv);

        if (isLong) {
          const toggle = doc.createElement("button");
          toggle.className = "abstract-toggle";
          toggle.textContent = "Show full abstract";
          let expanded = false;
          toggle.addEventListener("click", (e) => {
            e.stopPropagation();
            expanded = !expanded;
            abstractDiv.textContent = expanded ? abstractVal : abstractVal.slice(0, PREVIEW_LEN) + "...";
            toggle.textContent = expanded ? "Show less" : "Show full abstract";
          });
          content.appendChild(toggle);
        }
      }

      // --- Extra field (PMID, etc.) ---
      const extraVal = (zoteroItem.getField("extra") as string) || "";
      if (extraVal) {
        const extraDiv = doc.createElement("div");
        extraDiv.className = "result-identifiers";
        extraDiv.textContent = extraVal.replace(/\n/g, " \u2022 ");
        content.appendChild(extraDiv);
      }

      // --- Action buttons ---
      const actions = doc.createElement("div");
      actions.className = "result-actions";

      const editBtn = doc.createElement("button");
      editBtn.className = "action-btn";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        try {
          openEditDialog(doc, zoteroItem, card);
        } catch (err) {
          Zotero.log("[InstantCite] openEditDialog error: " + err);
        }
      });
      actions.appendChild(editBtn);

      const autoUpdateBtn = doc.createElement("button");
      autoUpdateBtn.className = "action-btn";
      autoUpdateBtn.textContent = "AutoUpdate";
      actions.appendChild(autoUpdateBtn);

      const doiVal = (zoteroItem.getField("DOI") as string) || "";
      if (doiVal) {
        const openBtn = doc.createElement("button");
        openBtn.className = "action-btn";
        openBtn.textContent = "Open in Browser";
        openBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          Zotero.launchURL("https://doi.org/" + doiVal);
        });
        actions.appendChild(openBtn);
      }

      content.appendChild(actions);

      // --- Source tag ---
      const tag = doc.createElement("div");
      tag.className = "result-sources";
      tag.textContent = "Already in citation \u2022 " + itemType;
      content.appendChild(tag);

      card.appendChild(content);

      // Pre-select this item — build a complete PaperResult from Zotero data
      const paperKey = "zotero:" + itemId;
      const journalVal = isBook
        ? ((zoteroItem.getField("publisher") as string) || "")
        : ((zoteroItem.getField("publicationTitle") as string) || "");
      const isbnVal = (zoteroItem.getField("ISBN") as string) || "";
      const abstractVal2 = (zoteroItem.getField("abstractNote") as string) || "";
      const extraForPaper = (zoteroItem.getField("extra") as string) || "";
      const pmidMatch = extraForPaper.match(/PMID:\s*(\d+)/);
      const fakePaper: PaperResult = {
        id: paperKey,
        title: titleVal,
        authors: authorNames.map((n: string) => ({ name: n })),
        year: parseInt(date?.slice(0, 4) || "0", 10),
        doi: (zoteroItem.getField("DOI") as string) || undefined,
        journal: journalVal || undefined,
        isbn: isbnVal || undefined,
        pmid: pmidMatch ? pmidMatch[1] : undefined,
        abstract: abstractVal2 || undefined,
        isOpenAccess: false,
        sources: ["Zotero"],
        _zoteroItemId: itemId,
      } as any;
      selectedPapers.set(paperKey, fakePaper);

      // Wire up AutoUpdate button (needs fakePaper)
      autoUpdateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleAutoUpdate(fakePaper, card);
      });

      // Preserve existing citation properties (locator, prefix, suffix)
      citationPropsMap.set(paperKey, {
        locator: citItem.locator || "",
        label: citItem.label || "page",
        prefix: citItem.prefix || "",
        suffix: citItem.suffix || "",
        suppressAuthor: !!(citItem["suppress-author"] || citItem.suppressAuthor),
      });

      checkbox.addEventListener("click", (e) => {
        e.stopPropagation();
        card.classList.toggle("selected", checkbox.checked);
        if (checkbox.checked) {
          selectedPapers.set(paperKey, fakePaper);
        } else {
          selectedPapers.delete(paperKey);
        }
        updateSelectionCount(doc);
      });

      // Single click on card toggles checkbox (but not on buttons/inputs)
      card.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "BUTTON" || target.tagName === "INPUT") return;
        checkbox.checked = !checkbox.checked;
        card.classList.toggle("selected", checkbox.checked);
        if (checkbox.checked) {
          selectedPapers.set(paperKey, fakePaper);
        } else {
          selectedPapers.delete(paperKey);
        }
        updateSelectionCount(doc);
      });

      container.appendChild(card);
    } catch (err) {
      Zotero.log("[InstantCite] Error loading citation item: " + err);
    }
  }

  updateSelectionCount(doc);
}

// ──────────────────────────────────────────────────────────────────────────
// Edit-dialog helpers (item types, field maps, author parsing)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Common Zotero item types — pinned to the top of the dropdown so the most-
 * used choices stay one click away. The rest of Zotero's types (bill, hearing,
 * presentation, dataset, audioRecording, etc.) are appended dynamically by
 * `getItemTypeOptions()` so we never silently drop a type the user might need.
 */
const COMMON_ITEM_TYPES: Array<{ value: string; label: string }> = [
  { value: "journalArticle", label: "Journal Article" },
  { value: "book", label: "Book" },
  { value: "bookSection", label: "Book Section" },
  { value: "conferencePaper", label: "Conference Paper" },
  { value: "report", label: "Report" },
  { value: "thesis", label: "Thesis" },
  { value: "webpage", label: "Web Page" },
  { value: "document", label: "Document" },
  { value: "letter", label: "Letter" },
  { value: "newspaperArticle", label: "Newspaper Article" },
  { value: "magazineArticle", label: "Magazine Article" },
  { value: "encyclopediaArticle", label: "Encyclopedia Article" },
  { value: "preprint", label: "Preprint" },
  { value: "patent", label: "Patent" },
  { value: "statute", label: "Statute" },
  { value: "bill", label: "Bill" },
  { value: "case", label: "Case" },
  { value: "hearing", label: "Hearing" },
];

/**
 * Build the full list of item types: COMMON_ITEM_TYPES first (pinned),
 * followed by every other Zotero type alphabetically by localized label.
 * Falls back to just the common list in test environments where Zotero is unavailable.
 */
function getItemTypeOptions(): Array<{ value: string; label: string }> {
  const result: Array<{ value: string; label: string }> = [...COMMON_ITEM_TYPES];
  const pinned = new Set(COMMON_ITEM_TYPES.map(t => t.value));

  try {
    if (typeof Zotero === "undefined" || !Zotero.ItemTypes?.getTypes) return result;
    const allTypes = Zotero.ItemTypes.getTypes() as Array<{ id: number; name: string }>;
    const extras: Array<{ value: string; label: string }> = [];
    for (const t of allTypes) {
      if (pinned.has(t.name)) continue;
      // Skip the "attachment" / "note" / "annotation" pseudo-types — they
      // aren't user-creatable references, just internal child item kinds.
      if (t.name === "attachment" || t.name === "note" || t.name === "annotation") continue;
      let label = t.name;
      try { label = Zotero.ItemTypes.getLocalizedString(t.id) || t.name; } catch { /* fallback to raw */ }
      extras.push({ value: t.name, label });
    }
    extras.sort((a, b) => a.label.localeCompare(b.label));
    result.push(...extras);
  } catch (err) {
    if (typeof Zotero !== "undefined") {
      Zotero.log("[InstantCite] getItemTypeOptions dynamic lookup failed: " + err);
    }
  }

  return result;
}

/** Field definition for the dynamic part of the edit form */
interface EditableField {
  label: string;
  zoteroField: string;
  isMultiline?: boolean;
}

/** Fields to skip in dynamic field generation (handled separately in the edit dialog) */
const SKIP_FIELDS = new Set(["title", "date", "abstractNote"]);

/** Fields that should use a multiline textarea */
const MULTILINE_FIELDS = new Set(["abstractNote", "extra"]);

/** Priority order for common fields (lower = earlier in the form). Unlisted fields default to 50. */
const FIELD_PRIORITY: Record<string, number> = {
  publicationTitle: 1, bookTitle: 1, publisher: 2, place: 3,
  volume: 5, issue: 6, pages: 7, numPages: 7,
  edition: 8, series: 9, section: 10,
  DOI: 20, ISBN: 21, ISSN: 22,
  language: 30, url: 35, accessDate: 36,
  rights: 40, extra: 45,
  abstractNote: 99,
};

/**
 * Return the editable fields appropriate for a given item type.
 * Uses Zotero.ItemFields API to dynamically get valid fields for ANY item type,
 * so we never miss types like bill, hearing, presentation, etc.
 */
function getFieldsForType(itemType: string): EditableField[] {
  try {
    const typeID = Zotero.ItemFields ? Zotero.ItemTypes.getID(itemType) : null;
    if (typeID && Zotero.ItemFields.getItemTypeFields) {
      const fieldIDs: number[] = Zotero.ItemFields.getItemTypeFields(typeID);
      const fields: EditableField[] = [];
      for (const fid of fieldIDs) {
        const fieldName = Zotero.ItemFields.getName(fid);
        if (!fieldName || SKIP_FIELDS.has(fieldName)) continue;
        // Skip type-specific aliases of base fields already handled statically
        // (e.g. caseName→title, dateDecided→date, nameOfAct→title)
        try {
          const baseID = Zotero.ItemFields.getBaseIDFromTypeAndField(typeID, fid);
          if (baseID) {
            const baseName = Zotero.ItemFields.getName(baseID);
            if (baseName && SKIP_FIELDS.has(baseName)) continue;
          }
        } catch { /* getBaseIDFromTypeAndField may not exist — proceed */ }
        const localizedName = Zotero.ItemFields.getLocalizedString(fid) || fieldName;
        fields.push({
          label: localizedName,
          zoteroField: fieldName,
          isMultiline: MULTILINE_FIELDS.has(fieldName),
        });
      }
      // Sort fields by priority (publication info first, identifiers, then misc)
      fields.sort((a, b) => (FIELD_PRIORITY[a.zoteroField] ?? 50) - (FIELD_PRIORITY[b.zoteroField] ?? 50));
      // Always add abstractNote at the end
      fields.push({ label: "Abstract", zoteroField: "abstractNote", isMultiline: true });
      return fields;
    }
  } catch (err) {
    if (typeof Zotero !== "undefined") {
      Zotero.log("[InstantCite] getFieldsForType dynamic lookup failed: " + err);
    }
  }

  // Fallback for test environment or if API unavailable
  return getFieldsForTypeFallback(itemType);
}

/** Static fallback field lists (used in tests or if Zotero API unavailable) */
function getFieldsForTypeFallback(itemType: string): EditableField[] {
  switch (itemType) {
    case "book":
      return [
        { label: "Publisher", zoteroField: "publisher" },
        { label: "Place", zoteroField: "place" },
        { label: "ISBN", zoteroField: "ISBN" },
        { label: "Edition", zoteroField: "edition" },
        { label: "# of Pages", zoteroField: "numPages" },
        { label: "Series", zoteroField: "series" },
        { label: "Language", zoteroField: "language" },
        { label: "DOI", zoteroField: "DOI" },
        { label: "URL", zoteroField: "url" },
        { label: "Abstract", zoteroField: "abstractNote", isMultiline: true },
      ];
    case "bookSection":
      return [
        { label: "Book Title", zoteroField: "bookTitle" },
        { label: "Publisher", zoteroField: "publisher" },
        { label: "Place", zoteroField: "place" },
        { label: "Pages", zoteroField: "pages" },
        { label: "ISBN", zoteroField: "ISBN" },
        { label: "Language", zoteroField: "language" },
        { label: "DOI", zoteroField: "DOI" },
        { label: "URL", zoteroField: "url" },
        { label: "Abstract", zoteroField: "abstractNote", isMultiline: true },
      ];
    default:
      return [
        { label: "Journal / Publication", zoteroField: "publicationTitle" },
        { label: "Volume", zoteroField: "volume" },
        { label: "Issue", zoteroField: "issue" },
        { label: "Pages", zoteroField: "pages" },
        { label: "Language", zoteroField: "language" },
        { label: "DOI", zoteroField: "DOI" },
        { label: "URL", zoteroField: "url" },
        { label: "Abstract", zoteroField: "abstractNote", isMultiline: true },
      ];
  }
}

/** Safely read a Zotero item field (returns "" on error) */
function safeGetField(zoteroItem: any, field: string): string {
  try {
    return (zoteroItem.getField(field) as string) || "";
  } catch {
    return "";
  }
}

/** Append a label + input row to a form container */
function appendFieldRow(
  doc: Document,
  container: HTMLElement,
  inputMap: Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  label: string,
  field: string,
  value: string,
) {
  const row = doc.createElement("div");
  row.className = "edit-modal-row";
  const lbl = doc.createElement("label");
  lbl.className = "edit-modal-label";
  lbl.textContent = label;
  row.appendChild(lbl);
  const input = doc.createElement("input") as HTMLInputElement;
  input.type = "text";
  input.className = "edit-modal-input";
  input.value = value;
  row.appendChild(input);
  container.appendChild(row);
  inputMap.set(field, input);
}

/**
 * Serialize Zotero creators array to a comma-separated string.
 * Corporate authors (fieldMode === 1) are wrapped in {braces}.
 */
function creatorsToString(creators: any[]): string {
  if (!creators || creators.length === 0) return "";
  return creators
    .map((c: any) => {
      if (c.fieldMode === 1) {
        // Corporate/institutional author
        return "{" + (c.lastName || "") + "}";
      }
      // Personal author: "LastName, FirstName"
      const first = c.firstName || "";
      const last = c.lastName || "";
      return first ? last + ", " + first : last;
    })
    .filter((n: string) => n.trim() !== "" && n !== "{}")
    .join("; ");
}

/**
 * Filter creators array to a specific type (e.g., "author", "editor").
 * Handles both creatorType (string) and creatorTypeID (number) formats.
 */
function creatorsOfType(creators: any[], type: string): any[] {
  return creators.filter((c: any) => {
    try {
      if (c.creatorType === type) return true;
      if (c.creatorTypeID !== undefined) {
        return Zotero.CreatorTypes.getName(c.creatorTypeID) === type;
      }
      return type === "author"; // default to author if no type info
    } catch {
      return type === "author";
    }
  });
}

/**
 * Parse a semicolon-separated creator string into structured objects.
 * Format: "LastName, FirstName; LastName, FirstName; {Corporate Name}"
 * Names in {braces} become corporate creators (fieldMode=1).
 */
function parseCreatorString(str: string): Array<{ firstName: string; lastName: string; fieldMode?: number }> {
  if (!str.trim()) return [];

  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  for (const ch of str) {
    if (ch === "{") { braceDepth++; current += ch; }
    else if (ch === "}") { braceDepth = Math.max(0, braceDepth - 1); current += ch; }
    else if (ch === ";" && braceDepth === 0) { parts.push(current.trim()); current = ""; }
    else { current += ch; }
  }
  if (current.trim()) parts.push(current.trim());

  const results: Array<{ firstName: string; lastName: string; fieldMode?: number }> = [];
  for (const part of parts) {
    if (!part) continue;
    const corpMatch = part.match(/^\{(.+)\}$/);
    if (corpMatch) {
      results.push({ firstName: "", lastName: corpMatch[1].trim(), fieldMode: 1 });
    } else if (part.includes(",")) {
      const commaIdx = part.indexOf(",");
      results.push({ firstName: part.substring(commaIdx + 1).trim(), lastName: part.substring(0, commaIdx).trim() });
    } else {
      results.push({ firstName: "", lastName: part.trim() });
    }
  }
  return results;
}

/**
 * Clear all creators on a Zotero item and rebuild from authors + editors strings.
 * Preserves corporate author syntax ({braces}).
 */
function parseAndSetAllCreators(zoteroItem: any, authorsStr: string, editorsStr: string) {
  const oldCount = zoteroItem.getCreators().length;
  for (let i = oldCount - 1; i >= 0; i--) {
    zoteroItem.removeCreator(i);
  }

  const authorTypeID = Zotero.CreatorTypes.getID("author");
  const editorTypeID = Zotero.CreatorTypes.getID("editor");

  let idx = 0;
  for (const c of parseCreatorString(authorsStr)) {
    zoteroItem.setCreator(idx++, { ...c, creatorTypeID: authorTypeID });
  }
  for (const c of parseCreatorString(editorsStr)) {
    zoteroItem.setCreator(idx++, { ...c, creatorTypeID: editorTypeID });
  }
}

/**
 * Open a modal edit dialog for a Zotero item.
 * All citation fields are shown as a form. Enter/OK saves, Escape cancels.
 * After saving, the card in the parent dialog is refreshed.
 */
function openEditDialog(doc: Document, zoteroItem: any, card: HTMLElement) {
  let currentItemType = zoteroItem.itemType as string;

  // Separate authors from editors — corporate names wrapped in {braces}
  const creators = zoteroItem.getCreators();
  const authorStr = creatorsToString(creatorsOfType(creators, "author"));
  const editorStr = creatorsToString(creatorsOfType(creators, "editor"));

  // --- Build modal overlay ---
  const overlay = doc.createElement("div");
  overlay.className = "edit-overlay";

  const modal = doc.createElement("div");
  modal.className = "edit-modal";

  // Header
  const modalHeader = doc.createElement("div");
  modalHeader.className = "edit-modal-header";
  modalHeader.textContent = "Edit Reference";
  modal.appendChild(modalHeader);

  // Form
  const form = doc.createElement("div");
  form.className = "edit-modal-form";
  const inputMap = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();

  // --- Item type selector (custom dropdown — native <select> popup broken in Gecko 140 XHTML dialogs) ---
  const typeRow = doc.createElement("div");
  typeRow.className = "edit-modal-row";
  const typeLabel = doc.createElement("label");
  typeLabel.className = "edit-modal-label";
  typeLabel.textContent = "Item Type";
  typeRow.appendChild(typeLabel);

  let typeUserChanged = false;

  // Build options list: pinned common types + every other Zotero type alphabetically.
  // If the current item's type isn't in either list (custom/legacy type), prepend it
  // so it doesn't silently disappear from the dropdown.
  const dynamicTypes = getItemTypeOptions();
  const knownTypes = new Set(dynamicTypes.map(t => t.value));
  const allTypeOptions: Array<{ value: string; label: string }> = [];
  if (!knownTypes.has(currentItemType)) {
    let label = currentItemType;
    try {
      const typeId = Zotero.ItemTypes.getID(currentItemType);
      label = Zotero.ItemTypes.getLocalizedString(typeId) || currentItemType;
    } catch { /* fallback */ }
    allTypeOptions.push({ value: currentItemType, label });
  }
  allTypeOptions.push(...dynamicTypes);

  // Custom dropdown wrapper
  const typeDropdown = doc.createElement("div");
  typeDropdown.className = "custom-select";

  const typeTrigger = doc.createElement("button");
  typeTrigger.type = "button";
  typeTrigger.className = "custom-select-trigger";
  const currentOpt = allTypeOptions.find(t => t.value === currentItemType);
  typeTrigger.textContent = currentOpt?.label ?? currentItemType;
  typeDropdown.appendChild(typeTrigger);

  const typeList = doc.createElement("div");
  typeList.className = "custom-select-options";
  typeList.style.display = "none";

  // Fake select to keep the same interface for save logic
  const typeSelect = { value: currentItemType } as { value: string; _listeners: Array<() => void> };
  (typeSelect as any)._listeners = [] as Array<() => void>;
  const typeSelectAddListener = (_: string, fn: () => void) => { (typeSelect as any)._listeners.push(fn); };
  const fireTypeChange = () => { for (const fn of (typeSelect as any)._listeners) fn(); };

  for (const t of allTypeOptions) {
    const optBtn = doc.createElement("button");
    optBtn.type = "button";
    optBtn.className = "custom-select-option" + (t.value === currentItemType ? " selected" : "");
    optBtn.textContent = t.label;
    optBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      typeSelect.value = t.value;
      typeTrigger.textContent = t.label;
      typeList.style.display = "none";
      typeList.querySelectorAll(".custom-select-option").forEach(o => o.classList.remove("selected"));
      optBtn.classList.add("selected");
      typeUserChanged = true;
      fireTypeChange();
    });
    typeList.appendChild(optBtn);
  }

  typeTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = typeList.style.display !== "none";
    typeList.style.display = isOpen ? "none" : "block";
  });

  // Close dropdown on outside click
  doc.addEventListener("click", () => { typeList.style.display = "none"; });

  typeDropdown.appendChild(typeList);
  typeRow.appendChild(typeDropdown);
  form.appendChild(typeRow);

  // --- Title ---
  appendFieldRow(doc, form, inputMap, "Title", "title", (zoteroItem.getField("title") as string) || "");

  // --- Authors ---
  const authorsRow = doc.createElement("div");
  authorsRow.className = "edit-modal-row";
  const authorsLabel = doc.createElement("label");
  authorsLabel.className = "edit-modal-label";
  authorsLabel.textContent = "Authors";
  authorsRow.appendChild(authorsLabel);
  const authorsInput = doc.createElement("input") as HTMLInputElement;
  authorsInput.type = "text";
  authorsInput.className = "edit-modal-input";
  authorsInput.value = authorStr;
  authorsInput.placeholder = "Nume, Prenume; Nume, Prenume; {Autor Instituțional}";
  authorsRow.appendChild(authorsInput);
  const authorsHint = doc.createElement("div");
  authorsHint.className = "edit-modal-hint";
  authorsHint.textContent = "Format: Nume, Prenume; Nume, Prenume — {acolade} pentru autori instituționali";
  authorsRow.appendChild(authorsHint);
  form.appendChild(authorsRow);
  inputMap.set("_authors", authorsInput);

  // --- Editors ---
  const editorsRow = doc.createElement("div");
  editorsRow.className = "edit-modal-row";
  const editorsLabel = doc.createElement("label");
  editorsLabel.className = "edit-modal-label";
  editorsLabel.textContent = "Editors";
  editorsRow.appendChild(editorsLabel);
  const editorsInput = doc.createElement("input") as HTMLInputElement;
  editorsInput.type = "text";
  editorsInput.className = "edit-modal-input";
  editorsInput.value = editorStr;
  editorsInput.placeholder = "Nume, Prenume; Nume, Prenume";
  editorsRow.appendChild(editorsInput);
  form.appendChild(editorsRow);
  inputMap.set("_editors", editorsInput);

  // --- Date ---
  appendFieldRow(doc, form, inputMap, "Date", "date", (zoteroItem.getField("date") as string) || "");

  // --- Dynamic fields container (changes based on item type) ---
  const dynamicFieldsContainer = doc.createElement("div");
  dynamicFieldsContainer.id = "edit-dynamic-fields";
  form.appendChild(dynamicFieldsContainer);

  /** Rebuild dynamic fields based on item type */
  const rebuildDynamicFields = (itemType: string) => {
    dynamicFieldsContainer.textContent = "";
    const dynFields = getFieldsForType(itemType);
    for (const f of dynFields) {
      const val = safeGetField(zoteroItem, f.zoteroField);
      if (f.isMultiline) {
        const row = doc.createElement("div");
        row.className = "edit-modal-row";
        const label = doc.createElement("label");
        label.className = "edit-modal-label";
        label.textContent = f.label;
        row.appendChild(label);
        const textarea = doc.createElement("textarea") as HTMLTextAreaElement;
        textarea.className = "edit-modal-textarea";
        textarea.value = val;
        textarea.rows = 4;
        row.appendChild(textarea);
        dynamicFieldsContainer.appendChild(row);
        inputMap.set(f.zoteroField, textarea);
      } else {
        appendFieldRow(doc, dynamicFieldsContainer, inputMap, f.label, f.zoteroField, val);
      }
    }
  };

  rebuildDynamicFields(currentItemType);

  // When item type changes, rebuild fields
  typeSelectAddListener("change", () => {
    // Remove old dynamic field keys from inputMap
    const dynFields = getFieldsForType(currentItemType);
    for (const f of dynFields) inputMap.delete(f.zoteroField);
    currentItemType = typeSelect.value;
    rebuildDynamicFields(currentItemType);
  });

  modal.appendChild(form);

  // Footer with buttons
  const footer = doc.createElement("div");
  footer.className = "edit-modal-footer";

  const cancelBtn = doc.createElement("button");
  cancelBtn.className = "footer-btn";
  cancelBtn.textContent = "Cancel";
  footer.appendChild(cancelBtn);

  const saveBtn = doc.createElement("button");
  saveBtn.className = "footer-btn primary";
  saveBtn.textContent = "Save";
  footer.appendChild(saveBtn);

  modal.appendChild(footer);
  overlay.appendChild(modal);
  doc.body.appendChild(overlay);

  // Focus title field
  const titleInput = inputMap.get("title");
  if (titleInput) {
    titleInput.focus();
    if (titleInput.tagName === "INPUT") (titleInput as HTMLInputElement).select();
  }

  // --- Event handlers ---
  let saving = false;
  const closeModal = () => {
    overlay.remove();
  };

  const saveAndClose = async () => {
    if (saving) return;
    saving = true;

    // Diagnostics — surfaced to the user if anything fails so silent drops
    // can no longer hide. Each entry includes the field, value attempted,
    // and the exact Zotero error message.
    const failedFields: Array<{ field: string; value: string; error: string }> = [];
    let saveTxError: string | null = null;
    let savedOk = false;

    try {
      // Change item type ONLY if user explicitly changed it in the dropdown.
      // setType MUST run before setField — Zotero clears fields not valid for
      // the new type when type changes, so any field set under the old type
      // would be lost otherwise.
      const newType = typeSelect.value;
      const oldType = zoteroItem.itemType as string;
      if (typeUserChanged && newType !== oldType) {
        try {
          zoteroItem.setType(Zotero.ItemTypes.getID(newType));
          Zotero.log("[InstantCite] Changed item type from " + oldType + " to " + newType);
        } catch (err) {
          saveTxError = "setType('" + newType + "') failed: " +
            (err instanceof Error ? err.message : String(err));
          Zotero.log("[InstantCite] " + saveTxError);
        }
      }

      const finalType = zoteroItem.itemType as string;

      // Save regular fields (skip creator fields)
      for (const [fieldName, input] of inputMap.entries()) {
        if (fieldName === "_authors" || fieldName === "_editors") continue;
        const newVal = input.value.trim();
        let oldVal = "";
        let oldValReadable = true;
        try {
          oldVal = (zoteroItem.getField(fieldName) as string) || "";
        } catch (err) {
          oldValReadable = false;
          Zotero.log("[InstantCite] getField('" + fieldName + "') failed on type '" + finalType + "': " + err);
        }
        // If we couldn't read the field AND the user didn't enter anything,
        // skip silently — the field genuinely doesn't apply here.
        if (!oldValReadable && !newVal) continue;
        if (oldValReadable && newVal === oldVal) continue;
        try {
          zoteroItem.setField(fieldName, newVal);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failedFields.push({ field: fieldName, value: newVal, error: msg });
          Zotero.log("[InstantCite] setField('" + fieldName + "', " +
            JSON.stringify(newVal) + ") failed on type '" + finalType + "': " + msg);
        }
      }

      // Save creators (authors + editors)
      const newAuthors = authorsInput.value.trim();
      const newEditors = editorsInput.value.trim();
      if (newAuthors !== authorStr || newEditors !== editorStr) {
        try {
          parseAndSetAllCreators(zoteroItem, newAuthors, newEditors);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failedFields.push({ field: "creators", value: newAuthors + " | " + newEditors, error: msg });
          Zotero.log("[InstantCite] setCreators failed on type '" + finalType + "': " + msg);
        }
      }

      try {
        await zoteroItem.saveTx();
        savedOk = true;
        Zotero.log("[InstantCite] Saved edits for item " + zoteroItem.id +
          " (type=" + finalType + ", failed=" + failedFields.length + ")");
      } catch (err) {
        saveTxError = err instanceof Error ? err.message : String(err);
        Zotero.log("[InstantCite] saveTx failed for item " + zoteroItem.id + ": " + saveTxError);
      }
    } catch (err) {
      saveTxError = "Unexpected: " + (err instanceof Error ? err.message : String(err));
      Zotero.log("[InstantCite] Unexpected save error: " + saveTxError);
    }

    saving = false;

    // Surface failures to the user. ps.alert is Zotero's standard prompt.
    if (saveTxError || failedFields.length > 0) {
      try {
        const ps = Services.prompt;
        const mainWin = Zotero.getMainWindow();
        const finalType = zoteroItem.itemType as string;

        let body = "";
        if (saveTxError) {
          body += "Salvarea a eșuat: " + saveTxError + "\n\n";
        }
        if (failedFields.length > 0) {
          body += "Următoarele câmpuri NU au putut fi salvate pentru tipul \"" +
            finalType + "\":\n\n";
          for (const f of failedFields) {
            const valShort = f.value.length > 60 ? f.value.slice(0, 60) + "…" : f.value;
            body += "• " + f.field + " = " + JSON.stringify(valShort) + "\n  → " + f.error + "\n";
          }
          if (savedOk) {
            body += "\nRestul modificărilor au fost salvate.";
          }
        }
        ps.alert(mainWin, "InstantCite — Salvare incompletă", body);
      } catch (alertErr) {
        Zotero.log("[InstantCite] Failed to show save-error alert: " + alertErr);
      }
    }

    if (savedOk) {
      refreshExistingCard(doc, zoteroItem, card);
    }
    closeModal();
  };

  cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); closeModal(); });
  saveBtn.addEventListener("click", (e) => { e.stopPropagation(); saveAndClose(); });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  // Keyboard: Escape cancels, Enter saves (except in textarea where Enter adds newline)
  // CRITICAL: stopPropagation prevents Escape from reaching the window-level handler
  // which would cancel the entire integration session and close the dialog
  const keyHandler = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); closeModal(); }
    if (e.key === "Enter" && (e.target as HTMLElement)?.tagName !== "TEXTAREA") {
      e.preventDefault();
      saveAndClose();
    }
  };
  overlay.addEventListener("keydown", keyHandler);
}

/**
 * Build the list of rows to render under a card's .citation-fields block
 * for ANY item type. Uses getFieldsForType so type-specific fields
 * (court, reporter, codeNumber, institution, etc.) are shown, not just
 * journal/volume/issue hardcoded for articles.
 */
function buildCitationFieldsDisplay(zoteroItem: any): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];

  const date = (zoteroItem.getField("date") as string) || "";
  if (date) fields.push({ label: "Date", value: date });

  const skipInCard = new Set(["abstractNote", "extra", "url", "accessDate", "language", "rights"]);
  const itemType = zoteroItem.itemType as string;
  try {
    const dynFields = getFieldsForType(itemType);
    let added = 0;
    for (const f of dynFields) {
      if (skipInCard.has(f.zoteroField)) continue;
      const val = safeGetField(zoteroItem, f.zoteroField);
      if (!val) continue;
      fields.push({ label: f.label, value: val });
      if (++added >= 6) break;
    }
  } catch (err) {
    Zotero.log("[InstantCite] buildCitationFieldsDisplay failed: " + err);
  }

  const doi = (zoteroItem.getField("DOI") as string) || "";
  if (doi && !fields.some(f => f.label === "DOI")) {
    fields.push({ label: "DOI", value: doi });
  }
  return fields;
}

/** Render a citation-fields block (used by both initial load and refresh) */
function renderCitationFieldsBlock(doc: Document, displayFields: Array<{ label: string; value: string }>): HTMLElement {
  const fieldRows = doc.createElement("div");
  fieldRows.className = "citation-fields";
  for (const f of displayFields) {
    if (!f.value) continue;
    const row = doc.createElement("div");
    row.className = "citation-field-row";
    const label = doc.createElement("span");
    label.className = "citation-field-label";
    label.textContent = f.label + ":";
    row.appendChild(label);
    const valueSpan = doc.createElement("span");
    valueSpan.className = "citation-field-value";
    valueSpan.textContent = f.value;
    row.appendChild(valueSpan);
    fieldRows.appendChild(row);
  }
  return fieldRows;
}

/** Refresh a card's displayed content after editing */
function refreshExistingCard(doc: Document, zoteroItem: any, card: HTMLElement) {
  const content = card.querySelector(".result-content");
  if (!content) return;

  const itemType = zoteroItem.itemType as string;

  // Update title
  const titleEl = content.querySelector(".result-title");
  if (titleEl) titleEl.textContent = (zoteroItem.getField("title") as string) || "Untitled";

  // Update authors
  let authorsEl = content.querySelector(".result-authors");
  const creators = zoteroItem.getCreators();
  const authorNames = (creators || [])
    .filter((c: any) => {
      const authorTypeID = Zotero.CreatorTypes.getID("author");
      return c.creatorTypeID === authorTypeID || !c.creatorTypeID;
    })
    .map((c: any) => c.fieldMode === 1 ? c.lastName : (c.firstName ? c.firstName + " " + c.lastName : c.lastName))
    .filter((n: string) => n && n.trim() !== "");
  if (authorsEl) {
    authorsEl.textContent = authorNames.join(", ");
  } else if (authorNames.length > 0) {
    authorsEl = doc.createElement("div");
    authorsEl.className = "result-authors";
    authorsEl.textContent = authorNames.join(", ");
    const titleDiv = content.querySelector(".result-title");
    if (titleDiv && titleDiv.nextSibling) {
      content.insertBefore(authorsEl, titleDiv.nextSibling);
    } else {
      content.appendChild(authorsEl);
    }
  }

  // Rebuild citation fields (type-aware)
  const oldFields = content.querySelector(".citation-fields");
  if (oldFields) {
    oldFields.replaceWith(renderCitationFieldsBlock(doc, buildCitationFieldsDisplay(zoteroItem)));
  }

  // Update the itemType tag at the bottom so it reflects a type change from the dropdown
  const tag = content.querySelector(".result-sources");
  if (tag) tag.textContent = "Already in citation \u2022 " + itemType;
}

/** Phase 1: Instant local search — triggered by debounced typing (500ms) */
async function performLocalSearch(win: Window) {
  const doc = win.document;
  const query = (doc.getElementById("search-input") as HTMLInputElement)?.value?.trim();
  if (!query || query.length < 2) return;

  // Don't overwrite full results with local-only results
  if (isFullSearchDone) return;

  // Check if Zotero source is enabled
  const zoteroCheckbox = doc.getElementById("src-zotero") as HTMLInputElement;
  if (zoteroCheckbox && !zoteroCheckbox.checked) return;

  try {
    const localResult = await searchZoteroLocal({ query, prioritizedItemIds: documentItemIds });
    // Don't overwrite if a full search completed while we were searching
    if (isFullSearchDone) return;

    if (localResult.results.length > 0) {
      currentResults = {
        papers: localResult.results,
        totalCount: localResult.results.length,
        sourceCounts: { Zotero: localResult.results.length },
        searchTimeMs: localResult.searchTimeMs,
        errors: [],
      };
      activeFilter = "all";
      updateSourceTabs(doc, currentResults.sourceCounts, currentResults.totalCount);
      renderCurrentResults(doc);

      const el = doc.getElementById("results-count");
      if (el) {
        el.textContent = localResult.results.length + " from My Library — press Search for online results";
      }
    }
  } catch (err) {
    // Silent fail for local search — user hasn't explicitly requested it
    if (typeof Zotero !== "undefined") {
      Zotero.log("[InstantCite] Local search error: " + err);
    }
  }
}

/** Phase 2: Full search — triggered by Search button or Enter */
async function performFullSearch(win: Window) {
  const doc = win.document;
  const query = (doc.getElementById("search-input") as HTMLInputElement)?.value?.trim();
  if (!query) return;

  // Cancel any pending local search
  if (localSearchTimer) {
    clearTimeout(localSearchTimer);
    localSearchTimer = null;
  }

  showLoading(doc);

  const options: SearchOptions = { query, maxResults: getMaxResults(), prioritizedItemIds: documentItemIds };

  // Year filter: check active button first, then custom range
  const activeYearBtn = doc.querySelector(".year-btn.active") as HTMLElement;
  const yearFrom = doc.getElementById("year-from") as HTMLInputElement;
  const yearTo = doc.getElementById("year-to") as HTMLInputElement;
  if (yearFrom?.value) {
    options.yearFrom = parseInt(yearFrom.value, 10);
    if (yearTo?.value) options.yearTo = parseInt(yearTo.value, 10);
  } else if (activeYearBtn?.dataset.year) {
    options.yearFrom = parseInt(activeYearBtn.dataset.year, 10);
  }

  const oaCheckbox = doc.getElementById("oa-filter") as HTMLInputElement;
  if (oaCheckbox?.checked) options.openAccessOnly = true;

  // Selected sources
  const sourceCheckboxes = doc.querySelectorAll(".source-checkbox") as NodeListOf<HTMLInputElement>;
  const selectedSources: string[] = [];
  for (const cb of sourceCheckboxes) {
    if (cb.checked) selectedSources.push(cb.dataset.source ?? "");
  }
  if (selectedSources.length > 0 && selectedSources.length < 6) {
    options.sources = selectedSources;
  }

  try {
    currentResults = await orchestrateSearch(options);
    isFullSearchDone = true;
    activeFilter = "all";
    // Don't clear selectedPapers — keep existing citation selections
    renderCurrentResults(doc);

    // Update results count with contextual info
    const el = doc.getElementById("results-count");
    if (el) {
      const timeStr = (currentResults.searchTimeMs / 1000).toFixed(1) + "s";
      if (currentResults.doiFallback) {
        // DOI lookup found nothing in CrossRef or PubMed \u2014 we fell back to text
        // search. Tell the user clearly so they know the DOI itself didn't match.
        el.textContent = "DOI not found in CrossRef or PubMed \u2014 showing " +
          currentResults.totalCount + " text-search results in " + timeStr;
      } else if (currentResults.errors.length > 0) {
        const errInfo = currentResults.errors.map(e => e.source + ": " + e.error).join("; ");
        el.textContent = currentResults.totalCount + " results in " + timeStr + " (" + errInfo + ")";
      } else if (currentResults.localSufficient) {
        el.textContent = currentResults.totalCount + " found in My Library \u2014 " + timeStr;
      }
    }
  } catch (err) {
    clearResults(doc);
    showError(doc, err instanceof Error ? err.message : "Search failed");
  } finally {
    hideLoading(doc);
  }
}

/** Get the active year filter range from UI state */
function getYearFilter(doc: Document): { from?: number; to?: number } {
  const activeYearBtn = doc.querySelector(".year-btn.active") as HTMLElement;
  const yearFromInput = doc.getElementById("year-from") as HTMLInputElement;
  const yearToInput = doc.getElementById("year-to") as HTMLInputElement;

  if (yearFromInput?.value) {
    const result: { from?: number; to?: number } = { from: parseInt(yearFromInput.value, 10) };
    if (yearToInput?.value) result.to = parseInt(yearToInput.value, 10);
    return result;
  }
  if (activeYearBtn?.dataset.year) {
    return { from: parseInt(activeYearBtn.dataset.year, 10) };
  }
  return {};
}

/** Get enabled sources from checkboxes */
function getEnabledSources(doc: Document): Set<string> {
  const enabled = new Set<string>();
  doc.querySelectorAll(".source-checkbox").forEach((cb) => {
    const checkbox = cb as HTMLInputElement;
    if (checkbox.checked) {
      enabled.add(checkbox.dataset.source ?? "");
    }
  });
  return enabled;
}

/** Apply all filters (source tab, source checkboxes, year, OA) and re-render */
function applyFiltersAndRender(doc: Document) {
  if (!currentResults) return;

  const enabledSources = getEnabledSources(doc);
  const yearFilter = getYearFilter(doc);
  const oaOnly = (doc.getElementById("oa-filter") as HTMLInputElement)?.checked ?? false;

  let filtered = currentResults.papers;

  // Filter by source checkboxes
  filtered = filtered.filter(p => p.sources.some(s => enabledSources.has(s)));

  // Filter by active source tab
  if (activeFilter !== "all") {
    filtered = filtered.filter(p => p.sources.includes(activeFilter));
  }

  // Filter by year
  if (yearFilter.from) {
    filtered = filtered.filter(p => p.year >= yearFilter.from!);
  }
  if (yearFilter.to) {
    filtered = filtered.filter(p => p.year <= yearFilter.to!);
  }

  // Filter by Open Access
  if (oaOnly) {
    filtered = filtered.filter(p => p.isOpenAccess);
  }

  // Update source tab counts based on checkbox-enabled + year-filtered results
  const filteredForCounts = currentResults.papers.filter(p => {
    if (!p.sources.some(s => enabledSources.has(s))) return false;
    if (yearFilter.from && p.year < yearFilter.from) return false;
    if (yearFilter.to && p.year > yearFilter.to) return false;
    if (oaOnly && !p.isOpenAccess) return false;
    return true;
  });
  const newCounts: Record<string, number> = {};
  for (const p of filteredForCounts) {
    for (const s of p.sources) {
      if (enabledSources.has(s)) {
        newCounts[s] = (newCounts[s] || 0) + 1;
      }
    }
  }
  updateSourceTabs(doc, newCounts, filteredForCounts.length);
  // Reset counts for disabled sources to 0
  doc.querySelectorAll(".source-checkbox").forEach((cb) => {
    const checkbox = cb as HTMLInputElement;
    const source = checkbox.dataset.source ?? "";
    if (!checkbox.checked && source) {
      const badge = doc.querySelector('.tab[data-source="' + source + '"] .badge');
      if (badge) badge.textContent = "0";
    }
  });

  // Update results count
  const el = doc.getElementById("results-count");
  if (el) {
    const total = currentResults.papers.length;
    if (filtered.length < total) {
      el.textContent = filtered.length + " of " + total + " results (filtered)";
    } else {
      el.textContent = total + " results";
    }
  }

  // Re-assert the tiers after filtering and after any manual sort: items cited
  // in the current document first, then the local library, then the internet.
  filtered = sortByProvenance(filtered, documentItemIds);

  const selectedIds = new Set(selectedPapers.keys());
  renderResults(doc, filtered, createSelectHandler(doc), onCardAction, selectedIds,
    documentItemIds.size > 0 ? documentItemIds : undefined);
}

function renderCurrentResults(doc: Document) {
  if (!currentResults) return;
  applyFiltersAndRender(doc);
}

function createSelectHandler(doc: Document) {
  return (paper: PaperResult, selected: boolean) => {
    if (selected) {
      selectedPapers.set(paper.id, paper);
    } else {
      selectedPapers.delete(paper.id);
    }
    updateSelectionCount(doc);
  };
}

function onCardAction(paper: PaperResult, action: "addLibrary" | "addCite" | "downloadPdf" | "edit" | "autoUpdate" | "openBrowser", card?: HTMLElement) {
  if (action === "addLibrary") {
    addSingleToLibrary(paper);
  } else if (action === "downloadPdf") {
    downloadPdfForPaper(paper, card);
  } else if (action === "openBrowser") {
    openPaperInBrowser(paper);
  } else if (action === "edit") {
    if (card) handleEditAction(paper, card);
  } else if (action === "autoUpdate") {
    if (card) handleAutoUpdate(paper, card);
  }
}

async function addSingleToLibrary(paper: PaperResult) {
  try {
    await addToZotero(paper);
    Zotero.log("[InstantCite] Added to library: " + paper.title);
  } catch (err) {
    Zotero.log("[InstantCite] Error adding paper: " + err);
  }
}

/** Force-download PDF (regardless of auto-download preference) and open it */
async function downloadPdfForPaper(paper: PaperResult, card?: HTMLElement) {
  // Find the download button in the card to update its text after completion
  const downloadBtn = card ? findActionButton(card, "Downloading...") : null;

  try {
    const item = await addToZotero(paper, true); // add to library without auto-PDF
    const result = await downloadAndOpenPDF(item, paper);

    if (downloadBtn) {
      if (result === "downloaded") {
        downloadBtn.textContent = "PDF Downloaded";
        downloadBtn.style.color = "#388e3c";
      } else if (result === "opened") {
        downloadBtn.textContent = "PDF Opened";
        downloadBtn.style.color = "#388e3c";
      } else {
        downloadBtn.textContent = "No PDF Found";
        downloadBtn.style.color = "#c62828";
        downloadBtn.style.pointerEvents = "";
      }
    }
  } catch (err) {
    Zotero.log("[InstantCite] Download PDF failed: " + err);
    if (downloadBtn) {
      downloadBtn.textContent = "Download Failed";
      downloadBtn.style.color = "#c62828";
      downloadBtn.style.pointerEvents = "";
    }
  }
}

/** Find an action button by its current text content */
function findActionButton(card: HTMLElement, text: string): HTMLElement | null {
  const buttons = card.querySelectorAll(".action-btn");
  for (const btn of buttons) {
    if (btn.textContent === text) return btn as HTMLElement;
  }
  return null;
}

/** Open paper: if PDF exists locally, open it; otherwise open in browser */
async function openPaperInBrowser(paper: PaperResult) {
  try {
    await openPaperOrPDF(paper);
  } catch (err) {
    Zotero.log("[InstantCite] Failed to open paper: " + err);
    // Fallback: try browser directly
    const url = paper.doi ? "https://doi.org/" + paper.doi : (paper.pdfUrl || null);
    if (url) {
      try { Zotero.launchURL(url); } catch { /* ignore */ }
    }
  }
}

/** Save paper to Zotero, then open the existing edit modal dialog */
async function handleEditAction(paper: PaperResult, card: HTMLElement) {
  const doc = card.ownerDocument;
  const editBtn = card.querySelector('.action-btn:nth-child(2)') as HTMLElement | null;
  if (editBtn) {
    editBtn.textContent = "Saving...";
    editBtn.style.pointerEvents = "none";
  }

  try {
    // Use existing Zotero item directly if known
    let zoteroItem;
    if ((paper as any)._zoteroItemId) {
      zoteroItem = Zotero.Items.get((paper as any)._zoteroItemId);
    }
    if (!zoteroItem) {
      zoteroItem = await addToZotero(paper, true);
    }
    if (editBtn) {
      editBtn.textContent = "Edit";
      editBtn.style.pointerEvents = "";
    }
    // Open the full edit modal with {braces} support for corporate authors
    openEditDialog(doc, zoteroItem, card);
  } catch (err) {
    Zotero.log("[InstantCite] Error preparing edit: " + err);
    if (editBtn) {
      editBtn.textContent = "Edit failed";
      editBtn.style.color = "#d32f2f";
      editBtn.style.pointerEvents = "";
    }
  }
}

async function handleAutoUpdate(paper: PaperResult, card: HTMLElement) {
  const doc = card.ownerDocument;
  const buttons = card.querySelectorAll(".action-btn");
  // Match by text OR dataset marker — survives prior clicks that changed the label
  let autoBtn = Array.from(buttons).find(b => b.textContent === "AutoUpdate") as HTMLElement | null;
  if (!autoBtn) autoBtn = card.querySelector('.action-btn[data-role="autoupdate"]') as HTMLElement | null;
  if (autoBtn) {
    autoBtn.dataset.role = "autoupdate";
    autoBtn.textContent = "Updating...";
    autoBtn.style.pointerEvents = "none";
  }

  // Safety: always restore the button, even on unexpected throw/hang paths
  const resetBtn = (text: string, color: string) => {
    if (!autoBtn) return;
    autoBtn.textContent = text;
    autoBtn.style.color = color;
    autoBtn.style.pointerEvents = "";
  };

  // Watchdog — if nothing resolves in 60s, flip button to a visible failure state
  // so the user is never left staring at "Updating..." forever.
  const watchdog = setTimeout(() => {
    Zotero.log("[InstantCite] AutoUpdate watchdog fired (60s elapsed with no result) for: " + paper.title);
    resetBtn("Timed out", "#d32f2f");
  }, 60000);

  let handledByEarlyReturn = false;
  try {
    Zotero.log("[InstantCite] AutoUpdate start: " + paper.title +
      " | doi=" + (paper.doi ?? "-") + " pmid=" + (paper.pmid ?? "-") + " isbn=" + (paper.isbn ?? "-"));

    // Use existing Zotero item directly if known (avoids duplicate risk)
    let zoteroItem;
    if ((paper as any)._zoteroItemId) {
      zoteroItem = Zotero.Items.get((paper as any)._zoteroItemId);
    }
    if (!zoteroItem) {
      Zotero.log("[InstantCite] AutoUpdate: saving paper to Zotero first");
      zoteroItem = await addToZotero(paper, true);
    }

    Zotero.log("[InstantCite] AutoUpdate: findAndMergeUpdates starting");
    const t0 = Date.now();
    const result = await findAndMergeUpdates(paper);
    Zotero.log("[InstantCite] AutoUpdate: findAndMergeUpdates done in " + (Date.now() - t0) +
      "ms, diffs=" + result.diffs.length + ", legislative=" + !!result.legislativeMatch);

    if (result.diffs.length === 0 && !result.legislativeMatch) {
      handledByEarlyReturn = true;
      resetBtn("No changes", "#888");
      return;
    }

    const mode = getAutoUpdateMode();
    Zotero.log("[InstantCite] AutoUpdate: mode=" + mode);

    if (mode === "silent") {
      applyAutoUpdates(zoteroItem, result, mode);
      await zoteroItem.saveTx();
    } else {
      const accepted = await showPreviewModal(
        doc, result.diffs, result.legislativeMatch, result.legislativeFields, mode,
      );
      if (accepted === null) {
        handledByEarlyReturn = true;
        resetBtn("Cancelled", "#888");
        return;
      }
      applyAutoUpdates(zoteroItem, result, mode, accepted);
      await zoteroItem.saveTx();
    }

    refreshExistingCard(doc, zoteroItem, card);
    resetBtn("Updated!", "#388e3c");
    Zotero.log("[InstantCite] AutoUpdate complete: " + paper.title + " (" + result.diffs.length + " changes)");
  } catch (err) {
    Zotero.log("[InstantCite] AutoUpdate error: " + err + " | stack: " + ((err as any)?.stack ?? "-"));
    try {
      const leftover = doc.getElementById("instantcite-autoupdate-overlay");
      if (leftover) leftover.remove();
    } catch { /* ignore */ }
    resetBtn("Update failed", "#d32f2f");
  } finally {
    clearTimeout(watchdog);
    // Final safety: if no branch above reset the button, reset it now so the UI
    // is never stuck at "Updating...".
    if (autoBtn && autoBtn.textContent === "Updating..." && !handledByEarlyReturn) {
      resetBtn("Finished", "#888");
    }
  }
}

function filterBySource(win: Window, source: string) {
  if (!currentResults) return;
  activeFilter = source;
  const doc = win.document;
  doc.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", (tab as HTMLElement).dataset.source === source);
  });
  renderCurrentResults(doc);
}

function sortResults(win: Window) {
  if (!currentResults) return;
  const dir = currentSortDir === "asc" ? 1 : -1;
  switch (currentSortField) {
    case "citations":
      currentResults.papers.sort((a, b) => dir * ((a.citationCount ?? 0) - (b.citationCount ?? 0)));
      break;
    case "date":
      currentResults.papers.sort((a, b) => dir * (a.year - b.year));
      break;
    default:
      currentResults.papers.sort((a, b) => dir * ((a.relevanceScore ?? 0) - (b.relevanceScore ?? 0)));
      break;
  }
  renderCurrentResults(win.document);
}

async function addSelectedToLibrary(doc: Document) {
  if (selectedPapers.size === 0) return;
  for (const paper of selectedPapers.values()) {
    if ((paper as any)._zoteroItemId) continue; // Already in library
    try {
      await addToZotero(paper);
    } catch (err) {
      Zotero.log("[InstantCite] Error adding: " + err);
    }
  }
  updateSelectionCount(doc);
}

/** Open the merge dialog with currently selected local Zotero items. */
function handleMergeSelected(win: Window, doc: Document) {
  const items: Zotero.Item[] = [];
  const paperKeysToRemove: string[] = [];

  for (const [key, paper] of selectedPapers.entries()) {
    const id = (paper as any)._zoteroItemId;
    if (!id) continue;
    const item = Zotero.Items.get(id);
    if (item) {
      items.push(item);
      paperKeysToRemove.push(key);
    }
  }

  if (items.length < 2) {
    Zotero.log("[InstantCite] Merge requested with <2 local items — ignoring");
    return;
  }

  openMergeDialog(doc, {
    items,
    onMerged: (master) => {
      Zotero.log("[InstantCite] Merge succeeded, master id=" + master.id);
      // Drop the merged items from selection (secondaries are trashed,
      // master is now a single conceptual item).
      for (const key of paperKeysToRemove) selectedPapers.delete(key);
      updateSelectionCount(doc);
      // Re-run the current search so the results list reflects the new state
      // (master appears once, secondaries gone from local search results).
      const searchInput = doc.getElementById("search-input") as HTMLInputElement | null;
      if (searchInput && searchInput.value.trim()) {
        performFullSearch(win);
      }
    },
  });
}

async function addAndCiteSelected(
  win: Window,
  acceptCitation: (items: Array<Record<string, any>>) => void,
) {
  const doc = win.document;
  const citeBtn = doc.getElementById("add-cite-btn") as HTMLElement | null;

  // Guard: verify integration state is still valid (could be cleared by race condition)
  if (!integrationIO || !integrationAcceptCb) {
    Zotero.log("[InstantCite] addAndCiteSelected: integration state already cleared (race condition?)");
    if (citeBtn) { citeBtn.textContent = "Integration lost — retry"; citeBtn.style.color = "#d32f2f"; citeBtn.style.pointerEvents = ""; }
    return;
  }

  if (selectedPapers.size === 0) {
    Zotero.log("[InstantCite] addAndCiteSelected: no papers selected, nothing to cite");
    if (citeBtn) { citeBtn.textContent = "No papers selected!"; citeBtn.style.color = "#d32f2f"; }
    setTimeout(() => { if (citeBtn) { citeBtn.textContent = "Cite Selected"; citeBtn.style.color = ""; } }, 2000);
    return;
  }

  // Visual feedback + block double-clicks
  if (citeBtn) {
    citeBtn.textContent = "Citing...";
    citeBtn.style.pointerEvents = "none";
  }

  Zotero.log("[InstantCite] Citing " + selectedPapers.size + " selected papers");
  const citationItems: Array<Record<string, any>> = [];

  for (const [key, paper] of selectedPapers.entries()) {
    const props = citationPropsMap.get(key);
    let itemId: number;

    // If it's already a Zotero item (from existing citation), use its ID directly
    if ((paper as any)._zoteroItemId) {
      itemId = (paper as any)._zoteroItemId;
      Zotero.log("[InstantCite] Existing item: " + key + " → id=" + itemId);
    } else {
      try {
        const item = await addToZotero(paper, true); // skipPDF for speed during cite
        itemId = item.id;
        Zotero.log("[InstantCite] Added/found item: " + key + " → id=" + itemId);
      } catch (err) {
        Zotero.log("[InstantCite] FAILED to add paper " + key + ": " + err);
        continue;
      }
    }

    const citItem: Record<string, any> = { id: itemId };
    if (props) {
      if (props.locator) {
        citItem.locator = props.locator;
        citItem.label = props.label || "page";
      }
      if (props.prefix) citItem.prefix = props.prefix;
      if (props.suffix) citItem.suffix = props.suffix;
      if (props.suppressAuthor) citItem["suppress-author"] = true;
    }
    citationItems.push(citItem);
  }

  Zotero.log("[InstantCite] Citation items before dedup: " + citationItems.length + " ids: " + citationItems.map(i => i.id).join(","));

  // Deduplicate by Zotero item ID (same paper can appear as zotero:X and pubmed:Y)
  const seen = new Set<number>();
  const uniqueItems = citationItems.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  Zotero.log("[InstantCite] Citation items after dedup: " + uniqueItems.length + " ids: " + uniqueItems.map(i => i.id).join(","));

  // Re-check integration state hasn't been cancelled during async addToZotero calls
  if (!integrationIO || !integrationAcceptCb) {
    Zotero.log("[InstantCite] WARNING: integration state cleared during async cite! Citation may not be inserted.");
    if (citeBtn) { citeBtn.textContent = "Integration lost"; citeBtn.style.color = "#d32f2f"; citeBtn.style.pointerEvents = ""; }
    return;
  }

  if (uniqueItems.length > 0) {
    try {
      acceptCitation(uniqueItems);
      Zotero.log("[InstantCite] acceptCitation completed successfully");
    } catch (err) {
      Zotero.log("[InstantCite] acceptCitation threw: " + err);
    }
  } else {
    Zotero.log("[InstantCite] No unique items to cite after dedup");
  }

  clearIntegrationState();
  closeDialogWindow(win, { cancelIntegration: false });
}

function updateSelectionCount(doc: Document) {
  const el = doc.getElementById("selection-count");
  if (el) el.textContent = selectedPapers.size + " selected";

  // Update citation details panel (integration mode only)
  const panel = doc.getElementById("citation-details-panel");
  if (panel) {
    const isIntegration = !!integrationIO;
    if (isIntegration && selectedPapers.size > 0) {
      panel.style.display = "";
      renderCitationDetailsPanel(doc);
    } else {
      panel.style.display = "none";
    }
  }

  // Merge button: visible only when 2+ selected items are local Zotero items
  const mergeBtn = doc.getElementById("merge-btn") as HTMLButtonElement | null;
  if (mergeBtn) {
    const localCount = countLocalSelected();
    if (localCount >= 2 && localCount === selectedPapers.size) {
      mergeBtn.style.display = "";
      mergeBtn.textContent = "Merge " + localCount;
    } else {
      mergeBtn.style.display = "none";
    }
  }
}

function countLocalSelected(): number {
  let n = 0;
  for (const paper of selectedPapers.values()) {
    if ((paper as any)._zoteroItemId) n++;
  }
  return n;
}


function showError(doc: Document, message: string) {
  const container = doc.getElementById("results-container");
  if (!container) return;
  container.textContent = "";
  const div = doc.createElement("div");
  div.className = "empty-state";
  div.textContent = message;
  container.appendChild(div);
}

/** Locator label options matching Zotero's CSL locator types */
const LOCATOR_LABELS: Array<{ value: string; label: string }> = [
  { value: "page", label: "Page(s)" },
  { value: "paragraph", label: "Paragraph" },
  { value: "line", label: "Line" },
  { value: "chapter", label: "Chapter" },
  { value: "section", label: "Section" },
  { value: "figure", label: "Figure" },
  { value: "column", label: "Column" },
  { value: "verse", label: "Verse" },
  { value: "volume", label: "Volume" },
  { value: "issue", label: "Issue" },
  { value: "note", label: "Note" },
  { value: "folio", label: "Folio" },
  { value: "sub verbo", label: "Sub verbo" },
];

/** Get or create default citation props for a paper key */
function getCitationProps(key: string): CitationProps {
  let props = citationPropsMap.get(key);
  if (!props) {
    props = { locator: "", label: "page", prefix: "", suffix: "", suppressAuthor: false };
    citationPropsMap.set(key, props);
  }
  return props;
}

/** Render the citation details panel with fields for each selected paper */
function renderCitationDetailsPanel(doc: Document) {
  const list = doc.getElementById("citation-details-list");
  if (!list) return;
  list.textContent = "";

  for (const [key, paper] of selectedPapers.entries()) {
    const props = getCitationProps(key);
    const row = doc.createElement("div");
    row.className = "citation-detail-row";

    // Paper title (truncated)
    const titleSpan = doc.createElement("span");
    titleSpan.className = "citation-detail-title";
    titleSpan.textContent = paper.title || "Untitled";
    titleSpan.title = paper.title || "";
    row.appendChild(titleSpan);

    // Prefix
    const prefixField = doc.createElement("div");
    prefixField.className = "citation-detail-field";
    const prefixLabel = doc.createElement("span");
    prefixLabel.className = "citation-detail-label";
    prefixLabel.textContent = "Prefix:";
    prefixField.appendChild(prefixLabel);
    const prefixInput = doc.createElement("input") as HTMLInputElement;
    prefixInput.type = "text";
    prefixInput.className = "citation-detail-input prefix-input";
    prefixInput.value = props.prefix;
    prefixInput.placeholder = "e.g. see ";
    prefixInput.addEventListener("input", () => { props.prefix = prefixInput.value; });
    prefixField.appendChild(prefixInput);
    row.appendChild(prefixField);

    // Locator type (dropdown)
    const locTypeField = doc.createElement("div");
    locTypeField.className = "citation-detail-field";
    const locSelect = doc.createElement("select");
    locSelect.className = "citation-detail-select";
    for (const opt of LOCATOR_LABELS) {
      const option = doc.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === props.label) option.selected = true;
      locSelect.appendChild(option);
    }
    locSelect.addEventListener("change", () => { props.label = locSelect.value; });
    locTypeField.appendChild(locSelect);
    row.appendChild(locTypeField);

    // Locator value
    const locField = doc.createElement("div");
    locField.className = "citation-detail-field";
    const locInput = doc.createElement("input") as HTMLInputElement;
    locInput.type = "text";
    locInput.className = "citation-detail-input locator-input";
    locInput.value = props.locator;
    locInput.placeholder = "e.g. 23-45";
    locInput.addEventListener("input", () => { props.locator = locInput.value; });
    locField.appendChild(locInput);
    row.appendChild(locField);

    // Suffix
    const suffixField = doc.createElement("div");
    suffixField.className = "citation-detail-field";
    const suffixLabel = doc.createElement("span");
    suffixLabel.className = "citation-detail-label";
    suffixLabel.textContent = "Suffix:";
    suffixField.appendChild(suffixLabel);
    const suffixInput = doc.createElement("input") as HTMLInputElement;
    suffixInput.type = "text";
    suffixInput.className = "citation-detail-input suffix-input";
    suffixInput.value = props.suffix;
    suffixInput.placeholder = "e.g. , table 3";
    suffixInput.addEventListener("input", () => { props.suffix = suffixInput.value; });
    suffixField.appendChild(suffixInput);
    row.appendChild(suffixField);

    // Suppress author
    const suppressField = doc.createElement("div");
    suppressField.className = "citation-detail-suppress";
    const suppressCheck = doc.createElement("input") as HTMLInputElement;
    suppressCheck.type = "checkbox";
    suppressCheck.checked = props.suppressAuthor;
    suppressCheck.addEventListener("change", () => { props.suppressAuthor = suppressCheck.checked; });
    suppressField.appendChild(suppressCheck);
    const suppressLabel = doc.createElement("span");
    suppressLabel.textContent = "Omit author";
    suppressField.appendChild(suppressLabel);
    row.appendChild(suppressField);

    list.appendChild(row);
  }
}

/** Save current source checkbox states to preferences */
function saveSourceSelections(doc: Document) {
  const disabled: string[] = [];
  doc.querySelectorAll(".source-checkbox").forEach((cb) => {
    const checkbox = cb as HTMLInputElement;
    const source = checkbox.dataset.source ?? "";
    if (!checkbox.checked && source) disabled.push(source);
  });
  setDisabledSources(disabled);
}

/** Restore source checkbox states from preferences */
function restoreSourceSelections(doc: Document) {
  const disabledSet = new Set(getDisabledSources());
  doc.querySelectorAll(".source-checkbox").forEach((cb) => {
    const checkbox = cb as HTMLInputElement;
    const source = checkbox.dataset.source ?? "";
    if (source) {
      checkbox.checked = !disabledSet.has(source);
    }
  });
}
