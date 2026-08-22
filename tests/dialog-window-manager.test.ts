import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPersistentDialogWindowForTests,
  clearPersistentDialogWindow,
  getPersistentDialogWindow,
  openFreshDialogWindow,
  openOrReuseDialogWindow,
  sendDialogToBackground,
} from "../src/modules/dialog-window-manager";

function createWindow() {
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    closed: false,
    focus: vi.fn(),
    blur: vi.fn(),
    close: vi.fn(function (this: any) { this.closed = true; }),
    addEventListener: vi.fn((type: string, fn: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    }),
    dispatch: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
  return win;
}

describe("dialog-window-manager", () => {
  beforeEach(() => {
    __resetPersistentDialogWindowForTests();
    delete (globalThis as typeof globalThis & { Zotero?: any }).Zotero;
  });

  it("opens a dialog once and focuses the same live window on reuse", () => {
    const dialogWin = createWindow();
    const mainWin = {
      openDialog: vi.fn(() => dialogWin),
    };
    const onLoad = vi.fn();

    const first = openOrReuseDialogWindow(mainWin as any, onLoad);
    dialogWin.dispatch("load");
    const second = openOrReuseDialogWindow(mainWin as any, onLoad);

    expect(first).toBe(dialogWin);
    expect(second).toBe(dialogWin);
    expect(mainWin.openDialog).toHaveBeenCalledTimes(1);
    expect(dialogWin.focus).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(getPersistentDialogWindow()).toBe(dialogWin);
  });

  it("forgets a cached dialog when it unloads or is closed", () => {
    const dialogWin = createWindow();
    const mainWin = { openDialog: vi.fn(() => dialogWin) };

    openOrReuseDialogWindow(mainWin as any, vi.fn());
    dialogWin.dispatch("unload");

    expect(getPersistentDialogWindow()).toBeNull();

    const closedWin = createWindow();
    closedWin.closed = true;
    clearPersistentDialogWindow(closedWin as any);

    expect(getPersistentDialogWindow()).toBeNull();
  });

  it("sends the dialog to the background without closing it", () => {
    const dialogWin = createWindow();
    const mainWin = { openDialog: vi.fn(() => dialogWin) };

    openOrReuseDialogWindow(mainWin as any, vi.fn());
    sendDialogToBackground(dialogWin as any);

    expect(dialogWin.blur).toHaveBeenCalledTimes(1);
    expect(dialogWin.closed).toBe(false);
    expect(getPersistentDialogWindow()).toBe(dialogWin);
  });

  it("opens a fresh dialog and closes any cached live dialog", () => {
    const oldWin = createWindow();
    const newWin = createWindow();
    const mainWin = { openDialog: vi.fn(() => oldWin) };

    openOrReuseDialogWindow(mainWin as any, vi.fn());
    mainWin.openDialog.mockReturnValue(newWin);

    const fresh = openFreshDialogWindow(mainWin as any, vi.fn());

    expect(fresh).toBe(newWin);
    expect(oldWin.close).toHaveBeenCalledTimes(1);
    expect(getPersistentDialogWindow()).toBe(newWin);
  });

  it("uses the configured dialog size when opening a fresh window", () => {
    const dialogWin = createWindow();
    const mainWin = { openDialog: vi.fn(() => dialogWin) };
    const globalWithZotero = globalThis as typeof globalThis & { Zotero?: any };
    globalWithZotero.Zotero = {
      Prefs: {
        get: vi.fn((name: string) => {
          if (name === "InstantCite.searchDialogWidth") return 920;
          if (name === "InstantCite.searchDialogHeight") return 640;
          return undefined;
        }),
      },
    };

    openFreshDialogWindow(mainWin as any, vi.fn());

    expect(mainWin.openDialog).toHaveBeenCalledWith(
      "chrome://instantcite/content/instantcite.xhtml",
      "instantcite-search",
      "chrome,centerscreen,resizable=yes,width=920,height=640",
    );
  });

});
