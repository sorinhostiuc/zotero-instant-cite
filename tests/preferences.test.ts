import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultLibreOfficeShortcut,
  getDefaultWordShortcut,
  getPref,
  getSearchDialogWindowSize,
  PREF_DEFS,
} from "../src/modules/preferences";

const globalWithZotero = globalThis as typeof globalThis & { Zotero?: any };

describe("preferences", () => {
  const prefs = new Map<string, unknown>();

  beforeEach(() => {
    prefs.clear();
    globalWithZotero.Zotero = {
      Prefs: {
        get: vi.fn((name: string) => prefs.get(name)),
        set: vi.fn((name: string, value: unknown) => prefs.set(name, value)),
      },
    };
  });

  it("uses the current InstantCite dialog size as the default", () => {
    expect(getSearchDialogWindowSize()).toEqual({ width: 1050, height: 800 });
  });

  it("clamps configured InstantCite dialog size to usable bounds", () => {
    prefs.set("InstantCite.searchDialogWidth", 400);
    prefs.set("InstantCite.searchDialogHeight", 300);

    expect(getSearchDialogWindowSize()).toEqual({ width: 760, height: 520 });

    prefs.set("InstantCite.searchDialogWidth", 5000);
    prefs.set("InstantCite.searchDialogHeight", 4000);

    expect(getSearchDialogWindowSize()).toEqual({ width: 3200, height: 2200 });
  });

  it("exposes dialog width and height in the settings dialog definitions", () => {
    expect(PREF_DEFS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "searchDialogWidth",
        label: "InstantCite window width",
        type: "number",
        unit: "px",
      }),
      expect.objectContaining({
        name: "searchDialogHeight",
        label: "InstantCite window height",
        type: "number",
        unit: "px",
      }),
    ]));
  });

  it("defaults the LibreOffice shortcut to Ctrl+Shift+I", () => {
    expect(getPref("libreOfficeShortcut")).toBe("Ctrl+Shift+I");
  });

  it("uses platform-aware Office shortcut defaults", () => {
    expect(getDefaultWordShortcut("macos")).toBe("Cmd+Shift+I");
    expect(getDefaultLibreOfficeShortcut("macos")).toBe("Cmd+Shift+I");
    expect(getDefaultWordShortcut("windows")).toBe("Ctrl+Shift+I");
    expect(getDefaultLibreOfficeShortcut("linux")).toBe("Ctrl+Shift+I");
  });
});
