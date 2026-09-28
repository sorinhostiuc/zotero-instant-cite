import { getSearchDialogWindowSize } from "./preferences";

type DialogWindow = Window & {
  _instantCiteInitialized?: boolean;
};

const DIALOG_URL = "chrome://instantcite/content/instantcite.xhtml";
const DIALOG_NAME = "instantcite-search";

let persistentDialogWindow: DialogWindow | null = null;

function getDialogFeatures(): string {
  const { width, height } = getSearchDialogWindowSize();
  return `chrome,centerscreen,resizable=yes,width=${width},height=${height}`;
}

function isLiveDialogWindow(win: DialogWindow | null): win is DialogWindow {
  return !!win && !(win as any).closed;
}

export function getPersistentDialogWindow(): DialogWindow | null {
  return isLiveDialogWindow(persistentDialogWindow) ? persistentDialogWindow : null;
}

export function clearPersistentDialogWindow(win?: Window) {
  if (!win || win === persistentDialogWindow) {
    persistentDialogWindow = null;
  }
}

/**
 * Raise a window to the foreground. On macOS a plain `win.focus()` is NOT
 * enough: a background app (Zotero) cannot steal focus from the frontmost app
 * (Word/LibreOffice), so the box loads behind it. Zotero.Utilities.Internal.
 * activate() does the real work — it focuses AND brings the process forward via
 * Carbon (and via AppleScript / X11 on the other platforms). It registers a
 * one-shot `load` listener for the Carbon call, so it must run *before* the
 * window finishes loading. Falls back to win.focus() outside Zotero (tests).
 */
function bringToForeground(win: Window) {
  try {
    if (typeof Zotero !== "undefined") {
      const activate = (Zotero as any)?.Utilities?.Internal?.activate;
      if (typeof activate === "function") {
        activate(win);
        return;
      }
    }
  } catch { /* ignore — fall back to focus */ }
  try { win.focus(); } catch { /* ignore */ }
}

/**
 * Open a new dialog window, cache it, and wire up its lifecycle. The window is
 * raised to the foreground — a window opened while another app (Word/
 * LibreOffice) is frontmost otherwise loads *behind* it.
 */
function createDialogWindow(
  mainWindow: Window & { openDialog: (...args: any[]) => Window },
  onLoad: (win: Window) => void,
): DialogWindow {
  const win = mainWindow.openDialog(DIALOG_URL, DIALOG_NAME, getDialogFeatures()) as DialogWindow;
  persistentDialogWindow = win;
  // Before load: activate() needs to hook the window's load event itself.
  bringToForeground(win);
  win.addEventListener("load", () => onLoad(win), { once: true } as any);
  win.addEventListener("unload", () => clearPersistentDialogWindow(win), { once: true } as any);
  return win;
}

export function openOrReuseDialogWindow(
  mainWindow: Window & { openDialog: (...args: any[]) => Window },
  onLoad: (win: Window) => void,
): Window {
  const existing = getPersistentDialogWindow();
  if (existing) {
    bringToForeground(existing);
    return existing;
  }

  return createDialogWindow(mainWindow, onLoad);
}

export function openFreshDialogWindow(
  mainWindow: Window & { openDialog: (...args: any[]) => Window },
  onLoad: (win: Window) => void,
): Window {
  const existing = getPersistentDialogWindow();
  if (existing) {
    clearPersistentDialogWindow(existing);
    try { existing.close(); } catch { /* ignore */ }
  }

  return createDialogWindow(mainWindow, onLoad);
}

export function sendDialogToBackground(win: Window) {
  try { win.blur(); } catch { /* ignore */ }
}

export function __resetPersistentDialogWindowForTests() {
  persistentDialogWindow = null;
}
