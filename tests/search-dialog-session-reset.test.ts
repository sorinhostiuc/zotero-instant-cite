import { beforeEach, describe, expect, it, vi } from "vitest";

const dialogWindowManager = vi.hoisted(() => ({
  getPersistentDialogWindow: vi.fn(),
  clearPersistentDialogWindow: vi.fn(),
  openFreshDialogWindow: vi.fn(),
  openOrReuseDialogWindow: vi.fn(),
  sendDialogToBackground: vi.fn(),
}));
const citationDialogReset = vi.hoisted(() => ({
  resetCitationDialogSurface: vi.fn(),
}));

vi.mock("../src/modules/dialog-window-manager", () => dialogWindowManager);
vi.mock("../src/modules/citation-dialog-reset", () => citationDialogReset);
vi.mock("../src/modules/result-renderer", () => ({
  renderResults: vi.fn(),
  clearResults: vi.fn(),
  updateSourceTabs: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));
vi.mock("../src/modules/search-orchestrator", () => ({
  orchestrateSearch: vi.fn(),
}));
vi.mock("../src/modules/api/zotero-local", () => ({
  searchZoteroLocal: vi.fn(),
}));
vi.mock("../src/modules/zotero-bridge", () => ({
  addToZotero: vi.fn(),
  downloadAndOpenPDF: vi.fn(),
  openPaperOrPDF: vi.fn(),
}));
vi.mock("../src/modules/settings-dialog", () => ({
  openSettingsDialog: vi.fn(),
}));
vi.mock("../src/modules/preferences", () => ({
  getDisabledSources: vi.fn(() => []),
  setDisabledSources: vi.fn(),
  getDefaultSort: vi.fn(() => "relevance"),
  getDefaultSortDir: vi.fn(() => "desc"),
  isLocalSearchEnabled: vi.fn(() => true),
  getMaxResults: vi.fn(() => 100),
  getAutoUpdateMode: vi.fn(() => "silent"),
  getSearchDialogWindowSize: vi.fn(() => ({ width: 1050, height: 800 })),
}));
vi.mock("../src/modules/auto-updater", () => ({
  findAndMergeUpdates: vi.fn(),
  applyAutoUpdates: vi.fn(),
  showPreviewModal: vi.fn(),
}));
vi.mock("../src/modules/dedup-dialog", () => ({
  openMergeDialog: vi.fn(),
}));
vi.mock("../src/modules/integration-patch", () => ({
  documentItemIds: new Set(),
  loadDocumentItemIdsFromCitationIO: vi.fn(),
}));
vi.mock("../src/modules/utils/document-priority", () => ({
  sortByProvenance: vi.fn((papers) => papers),
}));

import {
  openSearchDialogForCitation,
  prepareSearchDialogForPendingCitation,
} from "../src/modules/search-dialog";

function createElement() {
  return {
    textContent: "",
    value: "",
    style: { pointerEvents: "", color: "" },
    classList: { toggle: vi.fn(), remove: vi.fn(), add: vi.fn(), contains: vi.fn(() => false) },
    dataset: {},
    addEventListener: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    remove: vi.fn(),
  };
}

function createInitializedDialog() {
  const elements = new Map<string, any>([
    ["add-cite-btn", createElement()],
    ["search-input", { ...createElement(), focus: vi.fn() }],
    ["selection-count", createElement()],
    ["citation-details-panel", createElement()],
    ["merge-btn", createElement()],
  ]);

  return {
    _instantCiteInitialized: true,
    closed: false,
    close: vi.fn(),
    focus: vi.fn(),
    addEventListener: vi.fn(),
    document: {
      getElementById: vi.fn((id: string) => elements.get(id) ?? null),
      querySelectorAll: vi.fn(() => []),
    },
  };
}

describe("search dialog session reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).Zotero;
  });

  it("closes any stale persistent dialog before Word prepares a new citation query", () => {
    const win = createInitializedDialog();
    dialogWindowManager.getPersistentDialogWindow.mockReturnValue(win);

    const didPrepare = prepareSearchDialogForPendingCitation();

    expect(didPrepare).toBe(true);
    expect(dialogWindowManager.clearPersistentDialogWindow).toHaveBeenCalledWith(win);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("registers the citation dialog as Zotero's current integration window", () => {
    const win = createInitializedDialog();
    dialogWindowManager.openFreshDialogWindow.mockReturnValue(win);
    const mainWindow = { openDialog: vi.fn() };
    const onCancel = vi.fn();
    (globalThis as any).Zotero = {
      getMainWindow: vi.fn(() => mainWindow),
      Integration: {
        currentWindow: false,
        currentWindowType: false,
      },
      log: vi.fn(),
    };

    openSearchDialogForCitation(
      { citation: { citationItems: [] } },
      [],
      vi.fn(),
      onCancel,
    );

    const commandWindow = (globalThis as any).Zotero.Integration.currentWindow;
    expect(commandWindow).not.toBe(win);
    expect(commandWindow._instantCiteDialogWindow).toBe(win);
    expect((globalThis as any).Zotero.Integration.currentWindowType).toBe("citation");
    expect((win as any).isPristine).toBe(true);

    commandWindow.cancel();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect((globalThis as any).Zotero.Integration.currentWindow).toBe(false);
    expect(win.close).toHaveBeenCalledTimes(1);

    delete (globalThis as any).Zotero;
  });

  it("closes the real dialog when Zotero closes the active command window", () => {
    const win = createInitializedDialog();
    dialogWindowManager.openFreshDialogWindow.mockReturnValue(win);
    const mainWindow = { openDialog: vi.fn() };
    (globalThis as any).Zotero = {
      getMainWindow: vi.fn(() => mainWindow),
      Integration: {
        currentWindow: false,
        currentWindowType: false,
      },
      log: vi.fn(),
    };

    openSearchDialogForCitation(
      { citation: { citationItems: [] } },
      [],
      vi.fn(),
      vi.fn(),
    );

    const commandWindow = (globalThis as any).Zotero.Integration.currentWindow;

    expect(commandWindow).not.toBe(win);
    expect(commandWindow.closed).toBe(false);

    commandWindow.close();

    expect(win.close).toHaveBeenCalledTimes(1);
    expect((globalThis as any).Zotero.Integration.currentWindow).toBe(false);

    delete (globalThis as any).Zotero;
  });

  it("opens a fresh dialog for every citation session", () => {
    const win = createInitializedDialog();
    dialogWindowManager.openFreshDialogWindow.mockReturnValue(win);
    const mainWindow = { openDialog: vi.fn() };
    (globalThis as any).Zotero = {
      getMainWindow: vi.fn(() => mainWindow),
      Integration: {
        currentWindow: false,
        currentWindowType: false,
      },
      log: vi.fn(),
    };

    openSearchDialogForCitation(
      { citation: { citationItems: [] } },
      [],
      vi.fn(),
      vi.fn(),
    );

    expect(win.close).not.toHaveBeenCalled();
    expect(dialogWindowManager.openFreshDialogWindow).toHaveBeenCalledTimes(1);
    expect((globalThis as any).Zotero.Integration.currentWindow._instantCiteDialogWindow).toBe(win);

    delete (globalThis as any).Zotero;
  });
});
