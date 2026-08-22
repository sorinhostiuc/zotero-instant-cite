import { openSearchDialog } from "./modules/search-dialog";
import { patchCitationDialog, unpatchCitationDialog } from "./modules/integration-patch";
import { runFixerWithUI, runAuthorRestoreWithUI } from "./modules/creator-fixer";
import { runDoiFixerWithUI } from "./modules/doi-fixer-dialog";
import { runBatchAutoUpdateWithUI } from "./modules/auto-updater";
import { updateSelectedItems } from "./modules/item-updater";

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

async function onStartup() {
  // Only wait for core initialization — patchCitationDialog just replaces function
  // references on Zotero.Integration, no DB or UI needed
  await Zotero.initializationPromise;

  patchCitationDialog();
  Zotero.log("[InstantCite] Plugin started v0.6.1 — AutoUpdate menu present");

  // Zotero 9 may fire onMainWindowLoad before startup() finishes.
  // If the main window is already open, register the menu now.
  // If not, retry after a delay (belt-and-suspenders fallback).
  function tryRegisterMenu() {
    try {
      const mainWin = Zotero.getMainWindow();
      if (mainWin) {
        Zotero.log("[InstantCite] Main window found, registering menu");
        registerMenuAndShortcut(mainWin);
        return true;
      }
      Zotero.log("[InstantCite] Main window not yet available");
      return false;
    } catch (e) {
      Zotero.log("[InstantCite] Menu registration attempt failed: " + e);
      return false;
    }
  }

  if (!tryRegisterMenu()) {
    setTimeout(() => {
      Zotero.log("[InstantCite] Retrying menu registration (2s fallback)");
      tryRegisterMenu();
    }, 2000);
    setTimeout(() => {
      if (!Zotero.getMainWindow()?.document?.getElementById("instantcite-menu-search")) {
        Zotero.log("[InstantCite] Final retry menu registration (5s fallback)");
        tryRegisterMenu();
      }
    }, 5000);
  }
}

function onShutdown() {
  unpatchCitationDialog();
  // Clean up UI elements from main window
  try {
    const mainWin = Zotero.getMainWindow();
    if (mainWin) {
      const doc = mainWin.document;
      const menuitem = doc.getElementById("instantcite-menu-search");
      if (menuitem) menuitem.remove();
      const fixItem = doc.getElementById("instantcite-menu-fix-creators");
      if (fixItem) fixItem.remove();
      const autoUpdateItem = doc.getElementById("instantcite-menu-autoupdate");
      if (autoUpdateItem) autoUpdateItem.remove();
      const restoreItem = doc.getElementById("instantcite-menu-restore-authors");
      if (restoreItem) restoreItem.remove();
      const keyEl = doc.getElementById("instantcite-key-shortcut");
      if (keyEl) keyEl.remove();
    }
  } catch { /* ignore during shutdown */ }
  Zotero.log("[InstantCite] Plugin shutdown");
}

function onMainWindowLoad(win: { window: Window }) {
  Zotero.log("[InstantCite] onMainWindowLoad fired");
  try {
    registerMenuAndShortcut(win.window);
  } catch (e) {
    Zotero.log("[InstantCite] registerMenuAndShortcut error: " + e);
  }
}

function onMainWindowUnload(_win: { window: Window }) {
  const doc = _win.window.document;
  const menuitem = doc.getElementById("instantcite-menu-search");
  if (menuitem) menuitem.remove();
  const fixItem = doc.getElementById("instantcite-menu-fix-creators");
  if (fixItem) fixItem.remove();
  const fixDoiItem = doc.getElementById("instantcite-menu-fix-dois");
  if (fixDoiItem) fixDoiItem.remove();
  const autoUpdateItem = doc.getElementById("instantcite-menu-autoupdate");
  if (autoUpdateItem) autoUpdateItem.remove();
  const restoreItem = doc.getElementById("instantcite-menu-restore-authors");
  if (restoreItem) restoreItem.remove();
  const keyEl = doc.getElementById("instantcite-key-shortcut");
  if (keyEl) keyEl.remove();
}

let menuRegistered = false;

function registerMenuAndShortcut(win: Window) {
  Zotero.log("[InstantCite] registerMenuAndShortcut called");
  const doc = win.document;

  // Already registered on this window
  if (doc.getElementById("instantcite-menu-search")) {
    Zotero.log("[InstantCite] Menu already registered, skipping");
    return;
  }

  const menuTools = doc.getElementById("menu_ToolsPopup");
  Zotero.log("[InstantCite] menu_ToolsPopup: " + (menuTools ? "found" : "NOT FOUND"));
  if (!menuTools) {
    Zotero.log("[InstantCite] menu_ToolsPopup not found");
    return;
  }

  // Create menuitem directly (no toolkit dependency — saves 3400 lines from bundle)
  const menuitem = doc.createElementNS(XUL_NS, "menuitem") as Element;
  menuitem.id = "instantcite-menu-search";
  menuitem.setAttribute("label", "Instant Cite - Search Papers");
  menuitem.setAttribute("image", "chrome://instantcite/content/icons/favicon@0.5x.png");
  menuitem.setAttribute("class", "menuitem-iconic");
  menuitem.setAttribute("key", "instantcite-key-shortcut");
  menuitem.addEventListener("command", () => openSearchDialog());
  menuTools.appendChild(menuitem);

  // Fix Creators menu item
  const fixItem = doc.createElementNS(XUL_NS, "menuitem") as Element;
  fixItem.id = "instantcite-menu-fix-creators";
  fixItem.setAttribute("label", "Instant Cite - Fix Creators");
  fixItem.setAttribute("image", "chrome://instantcite/content/icons/favicon@0.5x.png");
  fixItem.setAttribute("class", "menuitem-iconic");
  fixItem.addEventListener("command", () => runFixerWithUI());
  menuTools.appendChild(fixItem);

  // Fix DOIs menu item
  const fixDoiItem = doc.createElementNS(XUL_NS, "menuitem") as Element;
  fixDoiItem.id = "instantcite-menu-fix-dois";
  fixDoiItem.setAttribute("label", "Instant Cite - Fix DOIs");
  fixDoiItem.setAttribute("image", "chrome://instantcite/content/icons/favicon@0.5x.png");
  fixDoiItem.setAttribute("class", "menuitem-iconic");
  fixDoiItem.addEventListener("command", () => runDoiFixerWithUI());
  menuTools.appendChild(fixDoiItem);

  // AutoUpdate Library menu item
  const autoUpdateItem = doc.createElementNS(XUL_NS, "menuitem") as Element;
  autoUpdateItem.id = "instantcite-menu-autoupdate";
  autoUpdateItem.setAttribute("label", "Instant Cite - AutoUpdate Library");
  autoUpdateItem.setAttribute("image", "chrome://instantcite/content/icons/favicon@0.5x.png");
  autoUpdateItem.setAttribute("class", "menuitem-iconic");
  autoUpdateItem.addEventListener("command", () => runBatchAutoUpdateWithUI());
  menuTools.appendChild(autoUpdateItem);

  // Restore Authors from CrossRef menu item
  const restoreItem = doc.createElementNS(XUL_NS, "menuitem") as Element;
  restoreItem.id = "instantcite-menu-restore-authors";
  restoreItem.setAttribute("label", "Instant Cite - Restore Authors from CrossRef");
  restoreItem.setAttribute("image", "chrome://instantcite/content/icons/favicon@0.5x.png");
  restoreItem.setAttribute("class", "menuitem-iconic");
  restoreItem.addEventListener("command", () => runAuthorRestoreWithUI());
  menuTools.appendChild(restoreItem);
  Zotero.log("[InstantCite] AutoUpdate menu item added to Tools");

  // Register Ctrl+Shift+I as a XUL <key> element in Zotero's main keyset
  const mainKeyset = doc.getElementById("mainKeyset");
  if (mainKeyset) {
    const keyEl = doc.createElementNS(XUL_NS, "key") as Element;
    keyEl.id = "instantcite-key-shortcut";
    keyEl.setAttribute("key", "I");
    keyEl.setAttribute("modifiers", "accel,shift");
    keyEl.setAttribute("oncommand", "void(0);");
    keyEl.addEventListener("command", () => openSearchDialog());
    mainKeyset.appendChild(keyEl);
  }

  // Fallback: Alt+Shift+P always works (not intercepted by DevTools)
  win.addEventListener("keydown", (ev: Event) => {
    const ke = ev as KeyboardEvent;
    if (ke.altKey && ke.shiftKey && ke.key === "P") {
      ke.preventDefault();
      openSearchDialog();
    }
  });

  // Register right-click context menu on library items
  registerItemContextMenu(win);

  Zotero.log("[InstantCite] Menu and shortcut registered");
}

function registerItemContextMenu(win: Window) {
  try {
    const doc = win.document;
    // Zotero's item tree context menu — fires on right-click
    const itemMenu = doc.getElementById("zotero-item-menu");
    if (!itemMenu) {
      Zotero.log("[InstantCite] zotero-item-menu not found — context menu not registered");
      return;
    }

    itemMenu.addEventListener("popupshowing", () => {
      // Remove any existing instance of our menu item
      const existing = doc.getElementById("instantcite-context-update");
      if (existing) existing.remove();

      const selectedItems = Zotero.getActiveZoteroPane()?.getSelectedItems?.() || [];
      if (selectedItems.length === 0) return;

      // Check if at least one item has DOI/ISBN/PMID
      const hasIdentifier = selectedItems.some((item: any) => {
        if (!item || item.isNote() || item.isAttachment()) return false;
        const doi = ((item.getField("DOI") as string) ?? "").trim();
        const isbn = ((item.getField("ISBN") as string) ?? "").trim();
        const pmid = ((item.getField("extra") as string)?.match(/PMID:\s*(\d+)/)?.[1] || "").trim();
        return !!(doi || isbn || pmid);
      });

      if (!hasIdentifier) return;

      // Add separator + menu item
      const sep = doc.createElementNS(XUL_NS, "menuseparator") as Element;
      itemMenu.appendChild(sep);

      const menuitem = doc.createElementNS(XUL_NS, "menuitem") as Element;
      menuitem.id = "instantcite-context-update";
      menuitem.setAttribute("label", selectedItems.length === 1
        ? "AutoUpdate from DOI/ISBN"
        : `AutoUpdate ${selectedItems.length} items from DOI/ISBN`);
      menuitem.setAttribute("image", "chrome://instantcite/content/icons/favicon@0.5x.png");
      menuitem.setAttribute("class", "menuitem-iconic");
      menuitem.addEventListener("command", () => updateSelectedItems());
      itemMenu.appendChild(menuitem);
    });
  } catch (e) {
    Zotero.log("[InstantCite] Context menu registration failed: " + e);
  }
}

export { onStartup, onShutdown, onMainWindowLoad, onMainWindowUnload };
