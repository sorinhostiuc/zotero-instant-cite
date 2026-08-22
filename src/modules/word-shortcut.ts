/**
 * Install a keyboard shortcut in Microsoft Word that triggers
 * Zotero's "Add/Edit Citation" command — which InstantCite intercepts.
 *
 * Uses PowerShell COM automation to bind the shortcut to ZoteroAddEditCitation
 * in Normal.dotm. Falls back to a small VBA wrapper if the direct binding is
 * not available.
 * Uses a separate AppleScript adapter on macOS.
 */

import { getDefaultWordShortcut, getPref } from "./preferences";
import { detectPlatform } from "./platform";
import { installWordMacShortcut, uninstallWordMacShortcut } from "./word-mac-shortcut";

/** Check if running on Windows */
export function isWindows(): boolean {
  return detectPlatform() === "windows";
}

/** Word key code constants for BuildKeyCode */
const WD_KEY: Record<string, number> = {
  Ctrl: 512,
  Cmd: 512,
  Command: 512,
  Shift: 256,
  Alt: 1024,
  Option: 1024,
};

const ADD_EDIT_CITATION_VBA = `Sub InstantCiteAddCitation()
    On Error GoTo AddEditFailed
    Application.Run "ZoteroAddEditCitation"
    Exit Sub

AddEditFailed:
    Err.Clear
    On Error GoTo ErrHandler
    Application.Run "ZoteroInsertCitation"
    Exit Sub

ErrHandler:
    MsgBox "Could not run Zotero citation command." & vbCrLf & _
           "Make sure Zotero is running and the Word plugin is installed.", _
           vbExclamation, "InstantCite"
End Sub`;

/** Map a letter to its Word key code (ASCII) */
function letterToKeyCode(letter: string): number {
  return letter.toUpperCase().charCodeAt(0);
}

/**
 * Parse a shortcut string like "Ctrl+Shift+I" into BuildKeyCode args.
 * Returns array of numeric codes for PowerShell's BuildKeyCode.
 */
export function parseShortcut(shortcut: string): number[] {
  const parts = shortcut.split("+").map(s => s.trim());
  const codes: number[] = [];
  for (const part of parts) {
    const upper = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    if (WD_KEY[upper]) {
      codes.push(WD_KEY[upper]);
    } else if (part.length === 1) {
      codes.push(letterToKeyCode(part));
    }
  }
  return codes;
}

/** Build the PowerShell statements required by Word's by-reference COM signature. */
function buildKeyCodePowerShell(shortcutCodes: number[]): string {
  const [firstCode, ...optionalCodes] = shortcutCodes;
  const assignments = optionalCodes.map(
    (code, index) => `    $keyCodePart${index + 2} = ${code}`,
  );
  const args = [
    String(firstCode),
    ...optionalCodes.map((_code, index) => `[ref]$keyCodePart${index + 2}`),
  ];

  return [
    ...assignments,
    `    $keyCode = $word.BuildKeyCode(${args.join(", ")})`,
  ].join("\n");
}

/** PowerShell script that installs the macro + shortcut into Normal.dotm */
export function buildPsScript(resultFilePath: string, shortcutCodes: number[]): string {
  // Escape backslashes for PowerShell string
  const resultFile = resultFilePath.replace(/\\/g, "\\\\");
  const keyCodePowerShell = buildKeyCodePowerShell(shortcutCodes);

  return `
$ErrorActionPreference = 'Stop'
$resultFile = "${resultFile}"

try {
    # Connect to running Word or start new instance
    $closeAfter = $false
    try {
        $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
    } catch {
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $closeAfter = $true
    }

    if (-not $word) {
        throw "Could not connect to Word. Make sure Microsoft Word is installed."
    }

    $normal = $word.NormalTemplate
    if (-not $normal) {
        throw "Could not access Normal.dotm template."
    }

    # Assign keyboard shortcut
    $word.CustomizationContext = $normal
${keyCodePowerShell}

    # Remove existing binding for this key combo if any
    foreach ($kb in $word.KeyBindings) {
        if ($kb.KeyCode -eq $keyCode) {
            $kb.Disable()
            break
        }
    }

    # Prefer the real Zotero command used by the Word ribbon button.
    # This avoids a separate wrapper macro and follows the same integration path
    # as clicking "Add/Edit Citation" in Word.
    $boundCommand = $null
    $bindingErrors = @()
    foreach ($cmd in @("ZoteroAddEditCitation", "ZoteroInsertCitation")) {
        try {
            # wdKeyCategoryMacro = 2
            $word.KeyBindings.Add(2, $cmd, $keyCode) | Out-Null
            $boundCommand = $cmd
            break
        } catch {
            $bindingErrors += ($cmd + ": " + $_.Exception.Message)
        }
    }

    # Fallback: create a small wrapper macro in Normal.dotm and bind to that.
    # This requires Trust Center access to the VBA project, so keep it second.
    if (-not $boundCommand) {
        $vbProject = $normal.VBProject
        if (-not $vbProject) {
            throw "Cannot bind to Zotero macros (" + ($bindingErrors -join "; ") + "). Also cannot access VBA project. In Word: File > Options > Trust Center > Trust Center Settings > Macro Settings > check 'Trust access to the VBA project object model'."
        }

        # Remove existing InstantCite module if present
        $toRemove = $null
        foreach ($comp in $vbProject.VBComponents) {
            if ($comp.Name -eq 'InstantCite') {
                $toRemove = $comp
                break
            }
        }
        if ($toRemove) {
            $vbProject.VBComponents.Remove($toRemove)
        }

        # Add new module with the fallback macro
        $module = $vbProject.VBComponents.Add(1)
        $module.Name = 'InstantCite'
        $code = @'
${ADD_EDIT_CITATION_VBA}
'@
        $module.CodeModule.AddFromString($code)

        foreach ($cmd in @("InstantCiteAddCitation", "Normal.InstantCite.InstantCiteAddCitation")) {
            try {
                $word.KeyBindings.Add(2, $cmd, $keyCode) | Out-Null
                $boundCommand = $cmd
                break
            } catch {
                $bindingErrors += ($cmd + ": " + $_.Exception.Message)
            }
        }
    }

    if (-not $boundCommand) {
        throw "Could not bind shortcut. " + ($bindingErrors -join "; ")
    }

    $normal.Save()

    if ($closeAfter) {
        $word.Quit([ref]$false)
    }

    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null

    "SUCCESS|$boundCommand" | Out-File -FilePath $resultFile -Encoding utf8 -NoNewline
}
catch {
    $msg = $_.Exception.Message
    if ($msg -match '(?i)trust|access.*VBA|programmatic') {
        "TRUST_ERROR|$msg" | Out-File -FilePath $resultFile -Encoding utf8 -NoNewline
    } else {
        "ERROR|$msg" | Out-File -FilePath $resultFile -Encoding utf8 -NoNewline
    }

    if ($word -and $closeAfter) {
        try { $word.Quit([ref]$false) } catch {}
    }
    if ($word) {
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch {}
    }
}
`;
}

/** PowerShell script to remove the macro + shortcut from Normal.dotm */
export function buildUninstallPsScript(resultFilePath: string): string {
  const resultFile = resultFilePath.replace(/\\/g, "\\\\");
  const keyCodePowerShell = buildKeyCodePowerShell([512, 256, 73]);

  return `
$ErrorActionPreference = 'Stop'
$resultFile = "${resultFile}"

try {
    $closeAfter = $false
    try {
        $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
    } catch {
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $closeAfter = $true
    }

    $normal = $word.NormalTemplate
    $vbProject = $normal.VBProject

    # Remove InstantCite module
    $found = $false
    foreach ($comp in $vbProject.VBComponents) {
        if ($comp.Name -eq 'InstantCite') {
            $vbProject.VBComponents.Remove($comp)
            $found = $true
            break
        }
    }

    # Remove Ctrl+Shift+I binding
    $word.CustomizationContext = $normal
${keyCodePowerShell}
    foreach ($kb in $word.KeyBindings) {
        if ($kb.KeyCode -eq $keyCode) {
            $kb.Disable()
            break
        }
    }

    $normal.Save()

    if ($closeAfter) {
        $word.Quit([ref]$false)
    }
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null

    if ($found) {
        "SUCCESS" | Out-File -FilePath $resultFile -Encoding utf8 -NoNewline
    } else {
        "NOT_FOUND" | Out-File -FilePath $resultFile -Encoding utf8 -NoNewline
    }
}
catch {
    $msg = $_.Exception.Message
    "ERROR|$msg" | Out-File -FilePath $resultFile -Encoding utf8 -NoNewline

    if ($word -and $closeAfter) {
        try { $word.Quit([ref]$false) } catch {}
    }
    if ($word) {
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch {}
    }
}
`;
}

/** Run a PowerShell script and return the result string */
async function runPowerShell(script: string): Promise<string> {
  const tempDir = Zotero.getTempDirectory().path;
  const scriptPath = PathUtils.join(tempDir, "instantcite_word.ps1");
  const resultPath = PathUtils.join(tempDir, "instantcite_word_result.txt");

  // Clean up previous result file
  try {
    await IOUtils.remove(resultPath);
  } catch {
    // Doesn't exist — fine
  }

  // Write PowerShell script
  await Zotero.File.putContentsAsync(scriptPath, script);

  // Derive Windows directory dynamically instead of hardcoding C:\Windows
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

  // Zotero.Utilities.Internal.exec — Gecko 140-safe process launcher
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

/** VBA code for manual installation instructions */
const MANUAL_VBA_CODE = ADD_EDIT_CITATION_VBA;

/**
 * Install the Word keyboard shortcut.
 * @param shortcut - e.g. "Ctrl+Shift+I", "Ctrl+Alt+Z"
 */
export async function installWordShortcut(shortcut = getDefaultWordShortcut()): Promise<{
  success: boolean;
  message: string;
  showManual?: boolean;
}> {
  const platform = detectPlatform();
  if (platform === "macos") return installWordMacShortcut(shortcut);
  if (platform !== "windows") {
    return { success: false, message: "Microsoft Word shortcut installation is not supported on this operating system.", showManual: true };
  }

  const codes = parseShortcut(shortcut);
  if (codes.length < 2) {
    return { success: false, message: "Invalid shortcut: " + shortcut + ". Use format like Ctrl+Shift+I." };
  }

  try {
    const tempDir = Zotero.getTempDirectory().path;
    const resultPath = PathUtils.join(tempDir, "instantcite_word_result.txt");
    const script = buildPsScript(resultPath, codes);
    const result = await runPowerShell(script);

    if (result === "SUCCESS" || result.startsWith("SUCCESS|")) {
      const boundCommand = result.includes("|") ? result.split("|").slice(1).join("|") : "ZoteroAddEditCitation";
      return {
        success: true,
        message: "Keyboard shortcut " + shortcut + " installed in Word!\n\n" +
          "The shortcut triggers '" + boundCommand + "' — the same command path as Zotero's Word button.\n" +
          "Restart Word if it was open during installation.",
      };
    }

    if (result.startsWith("TRUST_ERROR")) {
      return {
        success: false,
        message: "Word blocks programmatic access to VBA projects.\n\n" +
          "To fix: Open Word → File → Options → Trust Center → " +
          "Trust Center Settings → Macro Settings → " +
          "check 'Trust access to the VBA project object model'\n\n" +
          "Then try again, or install manually (see below).",
        showManual: true,
      };
    }

    const errorMsg = result.split("|").slice(1).join("|") || result;
    return {
      success: false,
      message: "Installation failed: " + errorMsg,
      showManual: true,
    };
  } catch (err) {
    return {
      success: false,
      message: "Could not run PowerShell: " + err,
      showManual: true,
    };
  }
}

/**
 * Remove the Word keyboard shortcut and VBA module.
 */
export async function uninstallWordShortcut(): Promise<{
  success: boolean;
  message: string;
}> {
  const platform = detectPlatform();
  if (platform === "macos") {
    return uninstallWordMacShortcut(getPref<string>("wordShortcut") || getDefaultWordShortcut("macos"));
  }
  if (platform !== "windows") {
    return { success: false, message: "Microsoft Word shortcut removal is not supported on this operating system." };
  }

  try {
    const tempDir = Zotero.getTempDirectory().path;
    const resultPath = PathUtils.join(tempDir, "instantcite_word_result.txt");
    const script = buildUninstallPsScript(resultPath);
    const result = await runPowerShell(script);

    if (result === "SUCCESS") {
      return { success: true, message: "Word shortcut removed successfully." };
    }
    if (result === "NOT_FOUND") {
      return { success: true, message: "No InstantCite shortcut was found in Word." };
    }

    const errorMsg = result.split("|").slice(1).join("|") || result;
    return { success: false, message: "Removal failed: " + errorMsg };
  } catch (err) {
    return { success: false, message: "Could not run PowerShell: " + err };
  }
}

/** Get the VBA code for manual installation */
export function getManualVbaCode(): string {
  return MANUAL_VBA_CODE;
}

/** Get manual installation instructions */
export function getManualInstructions(shortcut = getDefaultWordShortcut()): string {
  if (detectPlatform() === "macos") {
    return `Manual installation on Word for Mac:

1. Open Microsoft Word
2. Go to Tools → Customize Keyboard
3. Select the Macros category
4. Select ZoteroAddEditCitation
5. Click in the new shortcut field and press ${shortcut}
6. Click Assign, then OK`;
  }
  return `Manual installation:

1. Open Word
2. Go to File → Options → Customize Ribbon → Keyboard Shortcuts (bottom)
3. In Categories, scroll to "Macros"
4. Select "ZoteroAddEditCitation"
5. Click in "Press new shortcut key", press ${shortcut}
6. Click "Assign", then "Close"

If "ZoteroAddEditCitation" is not listed:
1. Press Alt+F11 (opens VBA Editor)
2. In the Project pane, double-click "Normal"
3. Right-click → Insert → Module
4. Paste the VBA code below and close the editor
5. Repeat the keyboard shortcut steps above, selecting "InstantCiteAddCitation"

VBA Code:
${MANUAL_VBA_CODE}`;
}
