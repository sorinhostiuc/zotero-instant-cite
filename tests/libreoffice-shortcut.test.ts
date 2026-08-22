import { describe, expect, it } from "vitest";
import {
  buildLibreOfficeAcceleratorItemPath,
  buildLibreOfficeAcceleratorItemXml,
  getLibreOfficeCommand,
  getLibreOfficeManualInstructions,
  getLibreOfficeProfileCandidates,
  parseLibreOfficeShortcut,
  rewriteLibreOfficeRegistryXml,
} from "../src/modules/libreoffice-shortcut";

const LO_COMMAND = getLibreOfficeCommand();

const baseRegistry = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Accelerators/PrimaryKeys/Global">
    <node oor:name="A_MOD1" oor:op="replace"><prop oor:name="Command"><value xml:lang="en-US">.uno:SelectAll</value></prop></node>
    <node oor:name="Z_MOD1" oor:op="replace"><prop oor:name="Command"><value xml:lang="en-US">${LO_COMMAND}</value></prop></node>
  </item>
</oor:items>`;

describe("LibreOffice shortcut helpers", () => {
  it("parses Ctrl+Shift+I into the global accelerator node name", () => {
    expect(parseLibreOfficeShortcut("Ctrl+Shift+I")).toEqual({
      keyName: "I",
      accelNodeName: "I_SHIFT_MOD1",
    });
  });

  it("maps macOS Command and Control to distinct LibreOffice modifiers", () => {
    expect(parseLibreOfficeShortcut("Cmd+Shift+I", "macos").accelNodeName).toBe("I_SHIFT_MOD1");
    expect(parseLibreOfficeShortcut("Ctrl+Shift+I", "macos").accelNodeName).toBe("I_SHIFT_MOD3");
    expect(parseLibreOfficeShortcut("Command+Option+I", "macos").accelNodeName).toBe("I_MOD1_MOD2");
  });

  it("builds platform-specific LibreOffice profile candidates", () => {
    const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

    expect(getLibreOfficeProfileCandidates("windows", "C:/Users/me", "C:/Users/me/AppData/Roaming", join)).toEqual([
      "C:/Users/me/AppData/Roaming/LibreOffice/4/user/registrymodifications.xcu",
    ]);
    expect(getLibreOfficeProfileCandidates("macos", "/Users/me", undefined, join)).toEqual([
      "/Users/me/Library/Application Support/LibreOffice/4/user/registrymodifications.xcu",
    ]);
    expect(getLibreOfficeProfileCandidates("linux", "/home/me", undefined, join)).toEqual([
      "/home/me/.config/libreoffice/4/user/registrymodifications.xcu",
      "/home/me/.var/app/org.libreoffice.LibreOffice/config/libreoffice/4/user/registrymodifications.xcu",
    ]);
  });

  it("builds the global accelerator path for LibreOffice", () => {
    expect(buildLibreOfficeAcceleratorItemPath("Ctrl+Shift+I")).toBe(
      "/org.openoffice.Office.Accelerators/PrimaryKeys/Global",
    );
  });

  it("builds the accelerator XML item for the Zotero command", () => {
    const xml = buildLibreOfficeAcceleratorItemXml("Ctrl+Shift+I", LO_COMMAND);
    expect(xml).toContain('oor:path="/org.openoffice.Office.Accelerators/PrimaryKeys/Global"');
    expect(xml).toContain('oor:name="I_SHIFT_MOD1"');
    expect(xml).toContain(LO_COMMAND);
  });

  it("writes a new global binding and removes duplicate command bindings elsewhere", () => {
    const result = rewriteLibreOfficeRegistryXml(baseRegistry, "Ctrl+Shift+I", LO_COMMAND, "install");

    expect(result.conflict).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(result.xml).toContain('oor:path="/org.openoffice.Office.Accelerators/PrimaryKeys/Global"');
    expect(result.xml).toContain('oor:name="I_SHIFT_MOD1"');
    expect(result.xml).toContain(LO_COMMAND);
    expect(result.xml).not.toContain('oor:name="Z_MOD1"');
  });

  it("migrates legacy accelerator entries to the current LibreOffice format", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Accelerators/PrimaryKeys/Global/I_SHIFT_MOD1/Command"><value xml:lang="en-US">${LO_COMMAND}</value></item>
</oor:items>`;
    const result = rewriteLibreOfficeRegistryXml(xml, "Ctrl+Shift+I", LO_COMMAND, "install");

    expect(result.changed).toBe(true);
    expect(result.xml).toContain('oor:path="/org.openoffice.Office.Accelerators/PrimaryKeys/Global"');
    expect(result.xml).toContain('oor:name="I_SHIFT_MOD1"');
    expect(result.xml).not.toContain('/Command"><value xml:lang="en-US">');
  });

  it("refuses to overwrite a different command bound to the same shortcut", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Accelerators/PrimaryKeys/Global">
    <node oor:name="I_SHIFT_MOD1" oor:op="replace"><prop oor:name="Command"><value xml:lang="en-US">.uno:OtherCommand</value></prop></node>
  </item>
</oor:items>`;
    const result = rewriteLibreOfficeRegistryXml(xml, "Ctrl+Shift+I", LO_COMMAND, "install");

    expect(result.changed).toBe(false);
    expect(result.conflict).toContain("Shortcut Ctrl+Shift+I is already bound to .uno:OtherCommand.");
  });

  it("removes the InstantCite binding without touching unrelated accelerators", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Accelerators/PrimaryKeys/Global">
    <node oor:name="I_SHIFT_MOD1" oor:op="replace"><prop oor:name="Command"><value xml:lang="en-US">${LO_COMMAND}</value></prop></node>
    <node oor:name="A_MOD1" oor:op="replace"><prop oor:name="Command"><value xml:lang="en-US">.uno:SelectAll</value></prop></node>
  </item>
</oor:items>`;
    const result = rewriteLibreOfficeRegistryXml(xml, "Ctrl+Shift+I", LO_COMMAND, "uninstall");

    expect(result.conflict).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(result.xml).not.toContain(LO_COMMAND);
    expect(result.xml).toContain('.uno:SelectAll');
  });

  it("describes the manual installation steps and command URL", () => {
    const text = getLibreOfficeManualInstructions("Ctrl+Shift+I");
    expect(text).toContain("Tools → Customize → Keyboard");
    expect(text).toContain(LO_COMMAND);
  });
});
