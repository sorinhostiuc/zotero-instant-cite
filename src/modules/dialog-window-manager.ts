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

export function openOrReuseDialogWindow(
  mainWindow: Window & { openDialog: (...args: any[]) => Window },
  onLoad: (win: Window) => void,
): Window {
  const existing = getPersistentDialogWindow();
  if (existing) {
    try { existing.focus(); } catch { /* ignore */ }
    return existing;
  }

  const win = mainWindow.openDialog(DIALOG_URL, DIALOG_NAME, getDialogFeatures()) as DialogWindow;
  persistentDialogWindow = win;
  win.addEventListener("load", () => onLoad(win), { once: true } as any);
  win.addEventListener("unload", () => clearPersistentDialogWindow(win), { once: true } as any);
  return win;
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

  const win = mainWindow.openDialog(DIALOG_URL, DIALOG_NAME, getDialogFeatures()) as DialogWindow;
  persistentDialogWindow = win;
  win.addEventListener("load", () => onLoad(win), { once: true } as any);
  win.addEventListener("unload", () => clearPersistentDialogWindow(win), { once: true } as any);
  return win;
}

export function sendDialogToBackground(win: Window) {
  try { win.blur(); } catch { /* ignore */ }
}

export function __resetPersistentDialogWindowForTests() {
  persistentDialogWindow = null;
}
