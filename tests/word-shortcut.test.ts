import { describe, expect, it } from "vitest";
import * as wordShortcut from "../src/modules/word-shortcut";

type ScriptBuilder = (resultFilePath: string, shortcutCodes: number[]) => string;
type UninstallScriptBuilder = (resultFilePath: string) => string;

describe("Word shortcut PowerShell generation", () => {
  it("parses the macOS Command modifier into Word's command key code", () => {
    expect(wordShortcut.parseShortcut("Cmd+Shift+I")).toEqual([512, 256, 73]);
  });

  it("passes optional BuildKeyCode arguments by reference during installation", () => {
    const buildPsScript = (wordShortcut as unknown as { buildPsScript?: ScriptBuilder }).buildPsScript;
    expect(buildPsScript).toBeTypeOf("function");

    const script = buildPsScript!("C:\\Temp\\instantcite-result.txt", [512, 256, 73]);

    expect(script).toContain("$keyCodePart2 = 256");
    expect(script).toContain("$keyCodePart3 = 73");
    expect(script).toContain(
      "$word.BuildKeyCode(512, [ref]$keyCodePart2, [ref]$keyCodePart3)",
    );
    expect(script).not.toContain("$word.BuildKeyCode(512, 256, 73)");
  });

  it("passes optional BuildKeyCode arguments by reference during removal", () => {
    const buildUninstallPsScript = (
      wordShortcut as unknown as { buildUninstallPsScript?: UninstallScriptBuilder }
    ).buildUninstallPsScript;
    expect(buildUninstallPsScript).toBeTypeOf("function");

    const script = buildUninstallPsScript!("C:\\Temp\\instantcite-result.txt");

    expect(script).toContain("$keyCodePart2 = 256");
    expect(script).toContain("$keyCodePart3 = 73");
    expect(script).toContain(
      "$word.BuildKeyCode(512, [ref]$keyCodePart2, [ref]$keyCodePart3)",
    );
    expect(script).not.toContain("$word.BuildKeyCode(512, 256, 73)");
  });
});
