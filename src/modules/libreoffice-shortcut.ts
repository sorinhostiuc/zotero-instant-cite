/**
 * Install a keyboard shortcut in LibreOffice that triggers
 * Zotero's "Add/Edit Citation" command.
 *
 * LibreOffice stores accelerator bindings in the user profile's
 * registrymodifications.xcu file under Office.Accelerators.
 * Supports Windows, macOS, and Linux.
 */

import { getDefaultLibreOfficeShortcut, getPref, setPref } from "./preferences";
import { detectPlatform, type InstantCitePlatform } from "./platform";

const LO_COMMAND = "service:org.zotero.integration.ooo.ZoteroOpenOfficeIntegration?addEditCitation";
const LO_PROFILE_SEGMENTS = ["LibreOffice", "4", "user", "registrymodifications.xcu"];
const ACCELERATOR_ROOT = "/org.openoffice.Office.Accelerators/PrimaryKeys/Global";

const ITEM_REGEX = /<item\s+oor:path="([^"]+)">([\s\S]*?)<\/item>/g;
const LEGACY_ACCELERATOR_ITEM_PATH_REGEX = new RegExp(`^${escapeRegExp(ACCELERATOR_ROOT)}/([^/]+)/Command$`);

interface ParsedShortcut {
  keyName: string;
  accelNodeName: string;
}

interface AcceleratorNode {
  name: string;
  command: string;
  legacy: boolean;
}

interface RegistryRewriteResult {
  xml: string;
  changed: boolean;
  conflict?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKeyToken(token: string): string {
  return token.trim().replace(/\s+/g, "").toUpperCase();
}

function normalizeModifierToken(
  token: string,
  platform: InstantCitePlatform,
): "SHIFT" | "MOD1" | "MOD2" | "MOD3" {
  const lower = token.trim().toLowerCase();
  if (lower === "shift") return "SHIFT";
  if (lower === "cmd" || lower === "command") return "MOD1";
  if (lower === "ctrl" || lower === "control") return platform === "macos" ? "MOD3" : "MOD1";
  if (lower === "alt" || lower === "option") return "MOD2";
  throw new Error("Unsupported modifier in shortcut: " + token);
}

function buildShortcutPieces(
  shortcut: string,
  platform: InstantCitePlatform,
): { keyName: string; parts: string[] } {
  const pieces = shortcut
    .split("+")
    .map(piece => piece.trim())
    .filter(Boolean);

  if (pieces.length < 2) {
    throw new Error("Invalid shortcut: " + shortcut + ". Use format like Ctrl+Shift+I.");
  }

  const keyPart = pieces[pieces.length - 1];
  const modifierNames = new Set(["ctrl", "control", "cmd", "command", "shift", "alt", "option"]);
  if (modifierNames.has(keyPart.toLowerCase())) {
    throw new Error("Invalid shortcut: " + shortcut + ". The last token must be the key, not a modifier.");
  }

  const keyName = normalizeKeyToken(keyPart);

  const modifiers = new Set(
    pieces.slice(0, -1).map(piece => normalizeModifierToken(piece, platform)),
  );

  const orderedParts = [keyName];
  for (const modifier of ["SHIFT", "MOD1", "MOD2", "MOD3"] as const) {
    if (modifiers.has(modifier)) orderedParts.push(modifier);
  }

  return { keyName, parts: orderedParts };
}

function getItemPathFromShortcut(shortcut: string): string {
  void shortcut;
  return ACCELERATOR_ROOT;
}

function buildItemXml(shortcut: string, command: string, platform: InstantCitePlatform): string {
  const parsed = parseLibreOfficeShortcut(shortcut, platform);
  return [
    `<item oor:path="${ACCELERATOR_ROOT}">`,
    `  <node oor:name="${parsed.accelNodeName}" oor:op="replace">`,
    `    <prop oor:name="Command"><value xml:lang="en-US">${escapeXml(command)}</value></prop>`,
    "  </node>",
    "</item>",
  ].join("\n");
}

function parseRegistryItems(xml: string): Array<{
  start: number;
  end: number;
  path: string;
  block: string;
  kind: "other" | "accelerator" | "legacy-accelerator";
  nodes: AcceleratorNode[];
}> {
  const items: Array<{
    start: number;
    end: number;
    path: string;
    block: string;
    kind: "other" | "accelerator" | "legacy-accelerator";
    nodes: AcceleratorNode[];
  }> = [];

  ITEM_REGEX.lastIndex = 0;
  for (const match of xml.matchAll(ITEM_REGEX)) {
    const start = match.index ?? 0;
    const block = match[0];
    const end = start + block.length;
    const path = match[1];

    if (path === ACCELERATOR_ROOT) {
      const nodes: AcceleratorNode[] = [];
      const nodeRegex = /<node\s+oor:name="([^"]+)"(?:\s+oor:op="[^"]+")?>([\s\S]*?)<\/node>/g;
      for (const nodeMatch of match[2].matchAll(nodeRegex)) {
        const nodeName = nodeMatch[1];
        const inner = nodeMatch[2];
        const commandPropMatch = inner.match(/<prop\s+oor:name="Command"[^>]*(?:\/>|>([\s\S]*?)<\/prop>)/i);
        let command = "";
        if (commandPropMatch && commandPropMatch[1]) {
          const valueMatch = commandPropMatch[1].match(/<value(?:\s+xml:lang="[^"]*")?>([\s\S]*?)<\/value>/i);
          command = valueMatch ? decodeXml(valueMatch[1].trim()) : "";
        }
        nodes.push({ name: nodeName, command, legacy: false });
      }

      items.push({ start, end, path, block, kind: "accelerator", nodes });
      continue;
    }

    const legacyMatch = path.match(LEGACY_ACCELERATOR_ITEM_PATH_REGEX);
    if (legacyMatch) {
      const nodes: AcceleratorNode[] = [];
      const valueMatch = match[2].match(/<value(?:\s+xml:lang="[^"]*")?>([\s\S]*?)<\/value>/i);
      const command = valueMatch ? decodeXml(valueMatch[1].trim()) : "";
      nodes.push({ name: legacyMatch[1], command, legacy: true });
      items.push({ start, end, path, block, kind: "legacy-accelerator", nodes });
      continue;
    }

    items.push({ start, end, path, block, kind: "other", nodes: [] });
  }

  return items;
}

function rewriteRegistryXml(
  xml: string,
  shortcut: string,
  command: string,
  mode: "install" | "uninstall",
  platform: InstantCitePlatform,
): RegistryRewriteResult {
  const closingTag = "</oor:items>";
  const closingIndex = xml.lastIndexOf(closingTag);
  if (closingIndex === -1) {
    throw new Error("LibreOffice registry file is malformed.");
  }

  const before = xml.slice(0, closingIndex);
  const after = xml.slice(closingIndex);
  const items = parseRegistryItems(before);
  const targetNodeName = parseLibreOfficeShortcut(shortcut, platform).accelNodeName;
  const nodesByName = new Map<string, AcceleratorNode>();
  const nodeOrder: string[] = [];
  let acceleratorSeen = false;
  let semanticChanged = false;
  let targetConflict: string | undefined;
  let targetSeen = false;

  for (const item of items) {
    if (item.kind === "other") {
      continue;
    }

    acceleratorSeen = true;

    if (item.kind === "legacy-accelerator") {
      semanticChanged = true;
    }

    for (const node of item.nodes) {
      if (!nodesByName.has(node.name)) {
        nodeOrder.push(node.name);
      }

      if (node.name === targetNodeName) {
        targetSeen = true;

        if (mode === "install" && node.command && node.command !== command) {
          targetConflict = node.command;
          continue;
        }

        if (mode === "uninstall") {
          if (node.command === command) {
            semanticChanged = true;
            continue;
          }
          nodesByName.set(node.name, { name: node.name, command: node.command, legacy: false });
          continue;
        }

        if (node.command !== command) {
          semanticChanged = true;
        }
        nodesByName.set(node.name, { name: node.name, command, legacy: false });
        continue;
      }

      if (mode === "install" && node.command === command) {
        semanticChanged = true;
        continue;
      }

      nodesByName.set(node.name, { name: node.name, command: node.command, legacy: false });
    }
  }

  if (targetConflict) {
    return {
      xml,
      changed: false,
      conflict: "Shortcut " + shortcut + " is already bound to " + targetConflict + ".",
    };
  }

  if (mode === "install" && !targetSeen) {
    semanticChanged = true;
    if (!nodesByName.has(targetNodeName)) {
      nodeOrder.push(targetNodeName);
    }
    nodesByName.set(targetNodeName, { name: targetNodeName, command, legacy: false });
  }

  if (!semanticChanged) {
    return {
      xml,
      changed: false,
    };
  }

  const rebuiltNodes = nodeOrder
    .filter(nodeName => nodesByName.has(nodeName))
    .map(nodeName => nodesByName.get(nodeName)!)
    .map(node => `  <node oor:name="${node.name}" oor:op="replace"><prop oor:name="Command"><value xml:lang="en-US">${escapeXml(node.command)}</value></prop></node>`)
    .join("\n");

  let rebuilt = "";
  let cursor = 0;
  for (const item of items) {
    rebuilt += before.slice(cursor, item.start);
    if (item.kind === "other") {
      rebuilt += item.block;
    }
    cursor = item.end;
  }
  rebuilt += before.slice(cursor);

  if (rebuiltNodes) {
    if (rebuilt && !rebuilt.endsWith("\n")) {
      rebuilt += "\n";
    }
    rebuilt += `<item oor:path="${ACCELERATOR_ROOT}">\n${rebuiltNodes}\n</item>\n`;
  }

  return {
    xml: rebuilt + after,
    changed: true,
  };
}

export function getLibreOfficeProfileCandidates(
  platform: InstantCitePlatform,
  homeDir: string,
  appDataDir?: string,
  joiner: (...parts: string[]) => string = (...parts) => PathUtils.join(...parts),
): string[] {
  if (platform === "windows") {
    return appDataDir ? [joiner(appDataDir, ...LO_PROFILE_SEGMENTS)] : [];
  }
  if (platform === "macos") {
    return [joiner(homeDir, "Library", "Application Support", ...LO_PROFILE_SEGMENTS)];
  }
  if (platform === "linux") {
    return [
      joiner(homeDir, ".config", "libreoffice", "4", "user", "registrymodifications.xcu"),
      joiner(homeDir, ".var", "app", "org.libreoffice.LibreOffice", "config", "libreoffice", "4", "user", "registrymodifications.xcu"),
    ];
  }
  return [];
}

function getRuntimeProfileCandidates(platform: InstantCitePlatform): string[] {
  const homeDir = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  let appDataDir: string | undefined;
  if (platform === "windows") {
    appDataDir = Services.dirsvc.get("AppData", Components.interfaces.nsIFile).path;
  }
  return getLibreOfficeProfileCandidates(platform, homeDir, appDataDir);
}

async function readProfileFile(path: string): Promise<string> {
  return Zotero.File.getContentsAsync(path) as Promise<string>;
}

async function readFirstProfile(candidates: string[]): Promise<{ path: string; contents: string } | null> {
  for (const path of candidates) {
    try {
      return { path, contents: await readProfileFile(path) };
    } catch {
      // Try the next supported profile location.
    }
  }
  return null;
}

async function writeProfileFile(path: string, contents: string): Promise<void> {
  await Zotero.File.putContentsAsync(path, contents);
}

async function backupProfileFile(path: string, backupPath: string): Promise<void> {
  const contents = await readProfileFile(path);
  await writeProfileFile(backupPath, contents);
}

async function restoreProfileFile(path: string, backupPath: string): Promise<void> {
  const contents = await readProfileFile(backupPath);
  await writeProfileFile(path, contents);
}

async function runPowerShell(script: string, resultFileName: string): Promise<string> {
  const tempDir = Zotero.getTempDirectory().path;
  const scriptPath = PathUtils.join(tempDir, "instantcite_libreoffice.ps1");
  const resultPath = PathUtils.join(tempDir, resultFileName);

  try {
    await IOUtils.remove(resultPath);
  } catch {
    // Ignore missing result files.
  }

  await Zotero.File.putContentsAsync(scriptPath, script);

  let winDir: string;
  try {
    winDir = Services.dirsvc.get("WinD", Components.interfaces.nsIFile).path;
  } catch {
    winDir = "C:\\Windows";
  }

  const psPath = PathUtils.join(winDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
  ];

  try {
    await Zotero.Utilities.Internal.exec(psPath, args);
  } catch (execErr: any) {
    return "ERROR|PowerShell failed: " + (execErr.message || execErr);
  }

  try {
    const result = await Zotero.File.getContentsAsync(resultPath) as string;
    return result.trim();
  } catch {
    return "ERROR|Could not read result file. PowerShell may have failed to start.";
  }
}

async function closeLibreOfficeWindows(): Promise<void> {
  const tempDir = Zotero.getTempDirectory().path;
  const resultPath = PathUtils.join(tempDir, "instantcite_libreoffice_close_result.txt");
  const resultFile = resultPath.replace(/\\/g, "\\\\");

  const result = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$resultFile = "${resultFile}"
try {
    $processes = Get-Process soffice, soffice.bin -ErrorAction SilentlyContinue
    foreach ($p in $processes) {
        try { [void]$p.CloseMainWindow() } catch {}
    }
    Start-Sleep -Seconds 3
    $leftover = Get-Process soffice, soffice.bin -ErrorAction SilentlyContinue
    if ($leftover) {
        $leftover | Stop-Process -Force
        Start-Sleep -Seconds 1
    }
    $stillRunning = Get-Process soffice, soffice.bin -ErrorAction SilentlyContinue
    if ($stillRunning) {
        throw "LibreOffice is still running."
    }
"SUCCESS" | Out-File -FilePath $resultFile -Encoding utf8 -NoNewline
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function closeLibreOfficeMac(): Promise<void> {
  const script = [
    'tell application "System Events" to set libreOfficeRunning to exists process "LibreOffice"',
    'if libreOfficeRunning then tell application "LibreOffice" to quit',
  ].join("\n");
  try {
    await Zotero.Utilities.Internal.exec("/usr/bin/osascript", ["-e", script]);
    await delay(1000);
  } catch (err: any) {
    throw new Error("Could not close LibreOffice on macOS: " + (err?.message || err));
  }
}

async function closeLibreOfficeLinux(): Promise<void> {
  try {
    await Zotero.Utilities.Internal.exec("/usr/bin/pkill", ["-TERM", "-x", "soffice.bin"]);
  } catch {
    // pkill exits with status 1 when no matching process exists.
  }
  try {
    await Zotero.Utilities.Internal.exec("/usr/bin/pkill", ["-TERM", "-x", "soffice"]);
  } catch {
    // pkill exits with status 1 when no matching process exists.
  }
  await delay(1000);
}

async function closeLibreOffice(platform: InstantCitePlatform): Promise<void> {
  if (platform === "windows") return closeLibreOfficeWindows();
  if (platform === "macos") return closeLibreOfficeMac();
  if (platform === "linux") return closeLibreOfficeLinux();
  throw new Error("LibreOffice shortcut setup is not supported on this operating system.");
}
catch {
    $msg = $_.Exception.Message
"ERROR|$msg" | Out-File -FilePath $resultFile -Encoding utf8 -NoNewline
}
`, "instantcite_libreoffice_close_result.txt");

  if (!result.startsWith("SUCCESS")) {
    const message = result.split("|").slice(1).join("|") || result;
    throw new Error(message);
  }
}

function getShortcutsFileTempPaths(): { backupPath: string } {
  const tempDir = Zotero.getTempDirectory().path;
  return {
    backupPath: PathUtils.join(tempDir, "instantcite_libreoffice_registrymodifications_backup.xcu"),
  };
}

/** Parse a shortcut string like "Ctrl+Shift+I" into LibreOffice accelerator parts. */
export function parseLibreOfficeShortcut(
  shortcut: string,
  platform: InstantCitePlatform = detectPlatform(),
): ParsedShortcut {
  const { keyName, parts } = buildShortcutPieces(shortcut, platform);
  return {
    keyName,
    accelNodeName: parts.join("_"),
  };
}

/** Build the LibreOffice registry path for the requested shortcut. */
export function buildLibreOfficeAcceleratorItemPath(shortcut: string): string {
  return getItemPathFromShortcut(shortcut);
}

/** Build the XML item used in registrymodifications.xcu for a shortcut binding. */
export function buildLibreOfficeAcceleratorItemXml(
  shortcut: string,
  command: string = LO_COMMAND,
  platform: InstantCitePlatform = detectPlatform(),
): string {
  return buildItemXml(shortcut, command, platform);
}

/** Update a LibreOffice registrymodifications.xcu string in memory. */
export function rewriteLibreOfficeRegistryXml(
  xml: string,
  shortcut: string,
  command: string = LO_COMMAND,
  mode: "install" | "uninstall" = "install",
  platform: InstantCitePlatform = detectPlatform(),
): RegistryRewriteResult {
  return rewriteRegistryXml(xml, shortcut, command, mode, platform);
}

/** Get the command URL used by InstantCite's LibreOffice shortcut. */
export function getLibreOfficeCommand(): string {
  return LO_COMMAND;
}

/** Get the LibreOffice manual setup instructions. */
export function getLibreOfficeManualInstructions(shortcut = getDefaultLibreOfficeShortcut()): string {
  return `Manual installation:

1. Open LibreOffice
2. Go to Tools → Customize → Keyboard
3. In Category, choose LibreOffice to make it available in all components
4. Search for the Zotero Add/Edit Citation command
5. Press ${shortcut} and click Modify/Assign

Command:
${LO_COMMAND}`;
}

/** Install the LibreOffice keyboard shortcut. */
export async function installLibreOfficeShortcut(shortcut = getPref<string>("libreOfficeShortcut") || getDefaultLibreOfficeShortcut()): Promise<{
  success: boolean;
  message: string;
  showManual?: boolean;
}> {
  const platform = detectPlatform();
  if (platform === "unsupported") {
    return { success: false, message: "LibreOffice shortcut installation is not supported on this operating system.", showManual: true };
  }

  try {
    parseLibreOfficeShortcut(shortcut, platform);
  } catch (err) {
    return { success: false, message: String(err), showManual: true };
  }

  const profileCandidates = getRuntimeProfileCandidates(platform);
  const { backupPath } = getShortcutsFileTempPaths();
  let profilePath: string | undefined;
  let backedUp = false;

  try {
    await closeLibreOffice(platform);

    const profile = await readFirstProfile(profileCandidates);
    if (!profile) {
      return {
        success: false,
        message: "Could not find a LibreOffice profile. Searched:\n" + profileCandidates.join("\n"),
        showManual: true,
      };
    }
    profilePath = profile.path;

    await backupProfileFile(profilePath, backupPath);
    backedUp = true;
    const result = rewriteLibreOfficeRegistryXml(profile.contents, shortcut, LO_COMMAND, "install", platform);

    if (result.conflict) {
      return { success: false, message: "Installation failed: " + result.conflict, showManual: true };
    }

    if (!result.changed) {
      setPref("libreOfficeShortcut", shortcut);
      return {
        success: true,
        message: "LibreOffice shortcut " + shortcut + " is already installed.",
      };
    }

    await writeProfileFile(profilePath, result.xml);
    setPref("libreOfficeShortcut", shortcut);
    try {
      await IOUtils.remove(backupPath);
    } catch {
      // ignore
    }

    return {
      success: true,
      message: "Keyboard shortcut " + shortcut + " installed in LibreOffice!\n\n" +
        "The shortcut now triggers Zotero's LibreOffice Add/Edit Citation command.\n" +
        "Restart LibreOffice if it was open during installation.",
    };
  } catch (err) {
    if (profilePath && backedUp) {
      try {
        await restoreProfileFile(profilePath, backupPath);
      } catch {
        // Ignore restore failures here; the original error is more useful.
      }
    }

    return {
      success: false,
      message: "Installation failed: " + err,
      showManual: true,
    };
  }
}

/** Remove the LibreOffice keyboard shortcut. */
export async function uninstallLibreOfficeShortcut(): Promise<{
  success: boolean;
  message: string;
}> {
  const platform = detectPlatform();
  if (platform === "unsupported") {
    return { success: false, message: "LibreOffice shortcut removal is not supported on this operating system." };
  }

  const shortcut = getPref<string>("libreOfficeShortcut") || getDefaultLibreOfficeShortcut();
  const profileCandidates = getRuntimeProfileCandidates(platform);
  const { backupPath } = getShortcutsFileTempPaths();
  let profilePath: string | undefined;
  let backedUp = false;

  try {
    await closeLibreOffice(platform);

    const profile = await readFirstProfile(profileCandidates);
    if (!profile) {
      return { success: true, message: "No LibreOffice profile was found, so there was nothing to remove." };
    }
    profilePath = profile.path;

    await backupProfileFile(profilePath, backupPath);
    backedUp = true;
    const result = rewriteLibreOfficeRegistryXml(profile.contents, shortcut, LO_COMMAND, "uninstall", platform);

    if (!result.changed) {
      try {
        await IOUtils.remove(backupPath);
      } catch {
        // ignore
      }
      return { success: true, message: "No InstantCite shortcut was found in LibreOffice." };
    }

    await writeProfileFile(profilePath, result.xml);
    try {
      await IOUtils.remove(backupPath);
    } catch {
      // ignore
    }

    return { success: true, message: "LibreOffice shortcut removed successfully." };
  } catch (err) {
    if (profilePath && backedUp) {
      try {
        await restoreProfileFile(profilePath, backupPath);
      } catch {
        // Ignore restore failures here; the original error is more useful.
      }
    }

    return { success: false, message: "Removal failed: " + err };
  }
}
