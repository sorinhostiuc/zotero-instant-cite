import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  getDefaultOfficeShortcut,
  getOfficeIntegrationVisibility,
} from "../src/modules/platform";

describe("platform helpers", () => {
  it.each([
    ["WINNT", "windows"],
    ["Darwin", "macos"],
    ["Linux", "linux"],
    ["Android", "unsupported"],
  ] as const)("maps %s to %s", (os, expected) => {
    expect(detectPlatform(os)).toBe(expected);
  });

  it("uses Command on macOS and Control elsewhere", () => {
    expect(getDefaultOfficeShortcut("macos")).toBe("Cmd+Shift+I");
    expect(getDefaultOfficeShortcut("windows")).toBe("Ctrl+Shift+I");
    expect(getDefaultOfficeShortcut("linux")).toBe("Ctrl+Shift+I");
  });

  it("shows only integrations supported by each platform", () => {
    expect(getOfficeIntegrationVisibility("windows")).toEqual({ word: true, libreOffice: true });
    expect(getOfficeIntegrationVisibility("macos")).toEqual({ word: true, libreOffice: true });
    expect(getOfficeIntegrationVisibility("linux")).toEqual({ word: false, libreOffice: true });
    expect(getOfficeIntegrationVisibility("unsupported")).toEqual({ word: false, libreOffice: false });
  });
});
