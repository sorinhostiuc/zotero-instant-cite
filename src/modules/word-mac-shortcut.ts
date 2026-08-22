import { getDefaultWordShortcut } from "./preferences";

export interface ShortcutResult {
  success: boolean;
  message: string;
  showManual?: boolean;
}

type WordMacMode = "install" | "remove";

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseMacShortcut(shortcut: string): { key: string; modifiers: string[] } {
  const parts = shortcut.split("+").map(part => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key || key.length !== 1 || parts.length === 0) {
    throw new Error("Invalid macOS shortcut: " + shortcut + ". Use format like Cmd+Shift+I.");
  }

  const modifiers = parts.map((part) => {
    const normalized = part.toLowerCase();
    if (normalized === "cmd" || normalized === "command") return "command down";
    if (normalized === "ctrl" || normalized === "control") return "control down";
    if (normalized === "shift") return "shift down";
    if (normalized === "alt" || normalized === "option") return "option down";
    throw new Error("Unsupported macOS shortcut modifier: " + part);
  });
  return { key: key.toLowerCase(), modifiers };
}

function buildWordMacScript(resultFilePath: string, shortcut: string, mode: WordMacMode): string {
  const { key, modifiers } = parseMacShortcut(shortcut);
  const resultPath = escapeAppleScript(resultFilePath);
  const shortcutText = escapeAppleScript(shortcut);
  const installAction = `
            try
                set shortcutField to first text field of keyboardDialog whose description contains "Press new keyboard shortcut"
                set focused of shortcutField to true
            on error
                set focused of last text field of keyboardDialog to true
            end try
            keystroke "${escapeAppleScript(key)}" using {${modifiers.join(", ")}}
            delay 0.3
            try
                set assignmentText to value of first static text of keyboardDialog whose value starts with "Currently assigned to"
                if assignmentText does not contain "[unassigned]" and assignmentText does not contain "ZoteroAddEditCitation" then
                    my writeResult("CONFLICT|" & assignmentText)
                    return
                end if
            end try
            click button "Assign" of keyboardDialog
            click button "OK" of keyboardDialog
            my writeResult("SUCCESS|${shortcutText}")`;
  const removeAction = `
            try
                set currentKeys to first list of keyboardDialog whose description contains "Current keys"
                if (count of rows of currentKeys) is 0 then
                    my writeResult("NOT_FOUND|No shortcut is assigned to ZoteroAddEditCitation.")
                    return
                end if
                select first row of currentKeys whose value of first static text contains "${shortcutText}"
            on error
                my writeResult("NOT_FOUND|The ${shortcutText} binding was not found.")
                return
            end try
            click button "Remove" of keyboardDialog
            click button "OK" of keyboardDialog
            my writeResult("SUCCESS|${shortcutText}")`;

  return `
property resultPath : "${resultPath}"

on writeResult(messageText)
    do shell script "/usr/bin/printf %s " & quoted form of messageText & " > " & quoted form of resultPath
end writeResult

try
    tell application "Microsoft Word" to activate
    delay 1
    tell application "System Events"
        tell process "Microsoft Word"
            set frontmost to true
            try
                click menu item "Customize Keyboard..." of menu "Tools" of menu bar 1
            on error
                click menu item "Customize Keyboard…" of menu "Tools" of menu bar 1
            end try
            delay 1
            set keyboardDialog to front window
            try
                set categoryList to first list of keyboardDialog whose description contains "Categories"
                select first row of categoryList whose value of first static text is "Macros"
            on error
                my writeResult("ERROR|Could not select the Macros category in Customize Keyboard.")
                return
            end try
            try
                set commandList to first list of keyboardDialog whose description contains "Commands"
                select first row of commandList whose value of first static text contains "ZoteroAddEditCitation"
            on error
                my writeResult("NOT_FOUND|ZoteroAddEditCitation was not found. Reinstall Zotero's Word integration.")
                return
            end try
${mode === "install" ? installAction : removeAction}
        end tell
    end tell
on error errorMessage number errorNumber
    if errorNumber is -1743 or errorNumber is -25211 then
        my writeResult("PERMISSION|macOS denied Automation or Accessibility access. Allow Zotero to control Microsoft Word and System Events, then try again.")
    else
        my writeResult("ERROR|" & errorMessage)
    end if
end try
`;
}

export function buildWordMacInstallScript(resultFilePath: string, shortcut: string): string {
  return buildWordMacScript(resultFilePath, shortcut, "install");
}

export function buildWordMacRemoveScript(resultFilePath: string, shortcut: string): string {
  return buildWordMacScript(resultFilePath, shortcut, "remove");
}

export function interpretWordMacResult(result: string, mode: WordMacMode): ShortcutResult {
  const separator = result.indexOf("|");
  const status = separator === -1 ? result : result.slice(0, separator);
  const detail = separator === -1 ? result : result.slice(separator + 1);
  if (status === "SUCCESS") {
    return {
      success: true,
      message: mode === "install"
        ? "Word shortcut installed on macOS. Restart Word if it was already open."
        : "Word shortcut removed on macOS.",
    };
  }
  if (status === "NOT_FOUND" && mode === "remove") {
    return { success: true, message: detail || "No InstantCite Word shortcut was found." };
  }
  return { success: false, message: detail || result, showManual: true };
}

async function runWordMacScript(script: string, mode: WordMacMode): Promise<ShortcutResult> {
  const tempDir = Zotero.getTempDirectory().path;
  const resultPath = PathUtils.join(tempDir, "instantcite_word_mac_result.txt");
  try {
    await IOUtils.remove(resultPath);
  } catch {
    // Ignore a missing previous result file.
  }

  try {
    await Zotero.Utilities.Internal.exec("/usr/bin/osascript", ["-e", script]);
  } catch {
    // The script writes a structured error before osascript exits.
  }

  try {
    const result = String(await Zotero.File.getContentsAsync(resultPath)).trim();
    return interpretWordMacResult(result, mode);
  } catch {
    return {
      success: false,
      message: "Could not run Word automation on macOS. Allow Automation and Accessibility access, then try again.",
      showManual: true,
    };
  }
}

export async function installWordMacShortcut(
  shortcut = getDefaultWordShortcut("macos"),
): Promise<ShortcutResult> {
  const resultPath = PathUtils.join(Zotero.getTempDirectory().path, "instantcite_word_mac_result.txt");
  return runWordMacScript(buildWordMacInstallScript(resultPath, shortcut), "install");
}

export async function uninstallWordMacShortcut(
  shortcut = getDefaultWordShortcut("macos"),
): Promise<ShortcutResult> {
  const resultPath = PathUtils.join(Zotero.getTempDirectory().path, "instantcite_word_mac_result.txt");
  return runWordMacScript(buildWordMacRemoveScript(resultPath, shortcut), "remove");
}
