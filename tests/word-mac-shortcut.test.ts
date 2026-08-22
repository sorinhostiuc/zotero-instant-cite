import { describe, expect, it } from "vitest";
import {
  buildWordMacInstallScript,
  buildWordMacRemoveScript,
  interpretWordMacResult,
} from "../src/modules/word-mac-shortcut";

describe("Word macOS shortcut automation", () => {
  it("builds an install script for the Zotero command and Command shortcut", () => {
    const script = buildWordMacInstallScript("/tmp/result.txt", "Cmd+Shift+I");

    expect(script).toContain('tell application "Microsoft Word" to activate');
    expect(script).toContain("Customize Keyboard");
    expect(script).toContain("ZoteroAddEditCitation");
    expect(script).toContain('keystroke "i" using {command down, shift down}');
    expect(script).toContain("PERMISSION|");
    expect(script).toContain("CONFLICT|");
  });

  it("builds a removal script that removes only the Zotero binding", () => {
    const script = buildWordMacRemoveScript("/tmp/result.txt", "Cmd+Shift+I");

    expect(script).toContain("ZoteroAddEditCitation");
    expect(script).toContain('click button "Remove"');
    expect(script).toContain("NOT_FOUND|");
  });

  it("turns permission failures into a manual fallback", () => {
    expect(interpretWordMacResult("PERMISSION|Accessibility access denied.", "install")).toEqual({
      success: false,
      message: "Accessibility access denied.",
      showManual: true,
    });
  });
});
