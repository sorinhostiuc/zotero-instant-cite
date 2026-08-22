/**
 * Settings dialog — modal overlay within the search dialog.
 * Reads/writes preferences via the preferences module.
 */

import {
  getPref, setPref,
  getDisabledSources, setDisabledSources,
  getDefaultLibreOfficeShortcut, getDefaultWordShortcut,
  PREF_DEFS, ALL_SOURCE_NAMES,
} from "./preferences";
import {
  installWordShortcut, uninstallWordShortcut,
  getManualInstructions,
} from "./word-shortcut";
import {
  installLibreOfficeShortcut, uninstallLibreOfficeShortcut,
  getLibreOfficeManualInstructions,
} from "./libreoffice-shortcut";
import { detectPlatform, getOfficeIntegrationVisibility } from "./platform";

/**
 * Open the settings dialog as a modal overlay inside the given document.
 * @param onClose - callback after settings are saved (to apply changes)
 */
export function openSettingsDialog(doc: Document, onClose?: () => void) {
  // --- Build modal overlay ---
  const overlay = doc.createElement("div");
  overlay.className = "edit-overlay";

  const modal = doc.createElement("div");
  modal.className = "edit-modal settings-modal";

  // Header
  const header = doc.createElement("div");
  header.className = "edit-modal-header";
  header.textContent = "InstantCite Settings";
  modal.appendChild(header);

  // Form
  const form = doc.createElement("div");
  form.className = "edit-modal-form";

  // --- Default sources section ---
  const sourcesSection = doc.createElement("div");
  sourcesSection.className = "settings-section";

  const sourcesTitle = doc.createElement("div");
  sourcesTitle.className = "settings-section-title";
  sourcesTitle.textContent = "Default Search Sources";
  sourcesSection.appendChild(sourcesTitle);

  const sourcesDesc = doc.createElement("div");
  sourcesDesc.className = "settings-description";
  sourcesDesc.textContent = "Sources enabled by default when opening the search dialog";
  sourcesSection.appendChild(sourcesDesc);

  const disabledSources = new Set(getDisabledSources());
  const sourceCheckboxes: Array<{ id: string; checkbox: HTMLInputElement }> = [];

  const sourcesGrid = doc.createElement("div");
  sourcesGrid.className = "settings-sources-grid";

  for (const source of ALL_SOURCE_NAMES) {
    const wrapper = doc.createElement("label");
    wrapper.className = "settings-checkbox-label";

    const cb = doc.createElement("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = !disabledSources.has(source.id);
    sourceCheckboxes.push({ id: source.id, checkbox: cb });

    wrapper.appendChild(cb);
    wrapper.appendChild(doc.createTextNode(" " + source.label));
    sourcesGrid.appendChild(wrapper);
  }
  sourcesSection.appendChild(sourcesGrid);
  form.appendChild(sourcesSection);

  // --- Separator ---
  form.appendChild(createSeparator(doc));

  // --- Other preferences ---
  const inputMap = new Map<string, HTMLInputElement | HTMLSelectElement>();

  for (const pref of PREF_DEFS) {
    const row = doc.createElement("div");
    row.className = "settings-row";

    const labelDiv = doc.createElement("div");
    labelDiv.className = "settings-row-label";

    const label = doc.createElement("div");
    label.className = "settings-label";
    label.textContent = pref.label;
    labelDiv.appendChild(label);

    if (pref.description) {
      const desc = doc.createElement("div");
      desc.className = "settings-description";
      desc.textContent = pref.description;
      labelDiv.appendChild(desc);
    }
    row.appendChild(labelDiv);

    const controlDiv = doc.createElement("div");
    controlDiv.className = "settings-row-control";

    if (pref.type === "boolean") {
      const toggle = doc.createElement("input") as HTMLInputElement;
      toggle.type = "checkbox";
      toggle.className = "settings-toggle";
      toggle.checked = getPref<boolean>(pref.name);
      controlDiv.appendChild(toggle);
      inputMap.set(pref.name, toggle);
    } else if (pref.type === "number") {
      const wrapper = doc.createElement("div");
      wrapper.className = "settings-number-wrapper";

      const input = doc.createElement("input") as HTMLInputElement;
      input.type = "number";
      input.className = "settings-number-input";
      input.min = String(pref.min ?? 1);
      input.max = String(pref.max ?? 100);
      input.value = String(getPref<number>(pref.name));
      wrapper.appendChild(input);

      if (pref.unit) {
        const unit = doc.createElement("span");
        unit.className = "settings-unit";
        unit.textContent = pref.unit;
        wrapper.appendChild(unit);
      }

      controlDiv.appendChild(wrapper);
      inputMap.set(pref.name, input);
    } else if (pref.type === "select") {
      const select = doc.createElement("select") as HTMLSelectElement;
      select.className = "settings-select";
      for (const opt of pref.options ?? []) {
        const option = doc.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        select.appendChild(option);
      }
      select.value = getPref<string>(pref.name);
      controlDiv.appendChild(select);
      inputMap.set(pref.name, select);
    }

    row.appendChild(controlDiv);
    form.appendChild(row);
  }

  const platform = detectPlatform();
  const integrationVisibility = getOfficeIntegrationVisibility(platform);
  const wordDefaultShortcut = getDefaultWordShortcut(platform);
  const libreOfficeDefaultShortcut = getDefaultLibreOfficeShortcut(platform);

  // --- Word Integration section ---
  if (integrationVisibility.word) {
    form.appendChild(createSeparator(doc));

    const wordSection = doc.createElement("div");
    wordSection.className = "settings-section";

    const wordTitle = doc.createElement("div");
    wordTitle.className = "settings-section-title";
    wordTitle.textContent = "Word Integration";
    wordSection.appendChild(wordTitle);

    const wordDesc = doc.createElement("div");
    wordDesc.className = "settings-description";
    wordDesc.textContent = "Install a keyboard shortcut in Word that triggers Add Citation";
    wordSection.appendChild(wordDesc);

    // Shortcut input row
    const shortcutRow = doc.createElement("div");
    shortcutRow.style.cssText = "display:flex;gap:8px;margin-top:8px;align-items:center;";
    const shortcutLabel = doc.createElement("span");
    shortcutLabel.className = "settings-label";
    shortcutLabel.textContent = "Shortcut:";
    shortcutRow.appendChild(shortcutLabel);
    const shortcutInput = doc.createElement("input") as HTMLInputElement;
    shortcutInput.type = "text";
    shortcutInput.className = "settings-number-input";
    shortcutInput.style.cssText = "width:160px;font-family:monospace;";
    shortcutInput.value = getPref<string>("wordShortcut") || wordDefaultShortcut;
    shortcutInput.placeholder = wordDefaultShortcut;
    shortcutRow.appendChild(shortcutInput);
    wordSection.appendChild(shortcutRow);

    const wordBtnRow = doc.createElement("div");
    wordBtnRow.style.cssText = "display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;";

    const installBtn = doc.createElement("button");
    installBtn.className = "footer-btn primary";
    installBtn.textContent = "Install Shortcut";
    installBtn.style.cssText = "margin:0;";

    const removeBtn = doc.createElement("button");
    removeBtn.className = "footer-btn";
    removeBtn.textContent = "Remove";
    removeBtn.style.cssText = "margin:0;";

    const manualBtn = doc.createElement("button");
    manualBtn.className = "footer-btn";
    manualBtn.textContent = "Manual Setup";
    manualBtn.style.cssText = "margin:0;";

    const wordStatus = doc.createElement("div");
    wordStatus.className = "settings-description";
    wordStatus.style.cssText = "margin-top:6px;white-space:pre-wrap;max-height:200px;overflow-y:auto;";

    installBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const shortcut = shortcutInput.value.trim() || wordDefaultShortcut;
      installBtn.disabled = true;
      installBtn.textContent = "Installing...";
      wordStatus.textContent = "";
      try {
        const res = await installWordShortcut(shortcut);
        wordStatus.textContent = res.message;
        wordStatus.style.color = res.success ? "#4caf50" : "#f44336";
        if (res.success) {
          setPref("wordShortcut", shortcut);
        }
        if (res.showManual) {
          manualBtn.style.display = "";
        }
      } catch (err) {
        wordStatus.textContent = "Error: " + err;
        wordStatus.style.color = "#f44336";
      }
      installBtn.disabled = false;
      installBtn.textContent = "Install Shortcut";
    });

    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      removeBtn.disabled = true;
      removeBtn.textContent = "Removing...";
      wordStatus.textContent = "";
      try {
        const res = await uninstallWordShortcut();
        wordStatus.textContent = res.message;
        wordStatus.style.color = res.success ? "#4caf50" : "#f44336";
      } catch (err) {
        wordStatus.textContent = "Error: " + err;
        wordStatus.style.color = "#f44336";
      }
      removeBtn.disabled = false;
      removeBtn.textContent = "Remove";
    });

    manualBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const shortcut = shortcutInput.value.trim() || wordDefaultShortcut;
      wordStatus.textContent = getManualInstructions(shortcut);
      wordStatus.style.color = "";
    });

    // Hide manual button initially — shown on error
    manualBtn.style.display = "none";

    wordBtnRow.appendChild(installBtn);
    wordBtnRow.appendChild(removeBtn);
    wordBtnRow.appendChild(manualBtn);
    wordSection.appendChild(wordBtnRow);
    wordSection.appendChild(wordStatus);
    form.appendChild(wordSection);
  }

  if (integrationVisibility.libreOffice) {
    form.appendChild(createSeparator(doc));

    const libreOfficeSection = doc.createElement("div");
    libreOfficeSection.className = "settings-section";

    const libreOfficeTitle = doc.createElement("div");
    libreOfficeTitle.className = "settings-section-title";
    libreOfficeTitle.textContent = "LibreOffice Integration";
    libreOfficeSection.appendChild(libreOfficeTitle);

    const libreOfficeDesc = doc.createElement("div");
    libreOfficeDesc.className = "settings-description";
    libreOfficeDesc.textContent =
      "Install a global keyboard shortcut in LibreOffice that triggers Zotero Add/Edit Citation. " +
      "Note: LibreOffice loads shortcut changes at startup, so close and reopen LibreOffice after installing.";
    libreOfficeSection.appendChild(libreOfficeDesc);

    const libreOfficeShortcutRow = doc.createElement("div");
    libreOfficeShortcutRow.style.cssText = "display:flex;gap:8px;margin-top:8px;align-items:center;";
    const libreOfficeShortcutLabel = doc.createElement("span");
    libreOfficeShortcutLabel.className = "settings-label";
    libreOfficeShortcutLabel.textContent = "Shortcut:";
    libreOfficeShortcutRow.appendChild(libreOfficeShortcutLabel);
    const libreOfficeShortcutInput = doc.createElement("input") as HTMLInputElement;
    libreOfficeShortcutInput.type = "text";
    libreOfficeShortcutInput.className = "settings-number-input";
    libreOfficeShortcutInput.style.cssText = "width:160px;font-family:monospace;";
    libreOfficeShortcutInput.value = getPref<string>("libreOfficeShortcut") || libreOfficeDefaultShortcut;
    libreOfficeShortcutInput.placeholder = libreOfficeDefaultShortcut;
    libreOfficeShortcutRow.appendChild(libreOfficeShortcutInput);
    libreOfficeSection.appendChild(libreOfficeShortcutRow);

    const libreOfficeBtnRow = doc.createElement("div");
    libreOfficeBtnRow.style.cssText = "display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;";

    const libreOfficeInstallBtn = doc.createElement("button");
    libreOfficeInstallBtn.className = "footer-btn primary";
    libreOfficeInstallBtn.textContent = "Install Shortcut";
    libreOfficeInstallBtn.style.cssText = "margin:0;";

    const libreOfficeRemoveBtn = doc.createElement("button");
    libreOfficeRemoveBtn.className = "footer-btn";
    libreOfficeRemoveBtn.textContent = "Remove";
    libreOfficeRemoveBtn.style.cssText = "margin:0;";

    const libreOfficeManualBtn = doc.createElement("button");
    libreOfficeManualBtn.className = "footer-btn";
    libreOfficeManualBtn.textContent = "Manual Setup";
    libreOfficeManualBtn.style.cssText = "margin:0;";

    const libreOfficeStatus = doc.createElement("div");
    libreOfficeStatus.className = "settings-description";
    libreOfficeStatus.style.cssText = "margin-top:6px;white-space:pre-wrap;max-height:200px;overflow-y:auto;";

    libreOfficeInstallBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const shortcut = libreOfficeShortcutInput.value.trim() || libreOfficeDefaultShortcut;
      libreOfficeInstallBtn.disabled = true;
      libreOfficeInstallBtn.textContent = "Installing...";
      libreOfficeStatus.textContent = "";
      try {
        const res = await installLibreOfficeShortcut(shortcut);
        libreOfficeStatus.textContent = res.message;
        libreOfficeStatus.style.color = res.success ? "#4caf50" : "#f44336";
        if (res.success) {
          setPref("libreOfficeShortcut", shortcut);
        }
        if (res.showManual) {
          libreOfficeManualBtn.style.display = "";
        }
      } catch (err) {
        libreOfficeStatus.textContent = "Error: " + err;
        libreOfficeStatus.style.color = "#f44336";
      }
      libreOfficeInstallBtn.disabled = false;
      libreOfficeInstallBtn.textContent = "Install Shortcut";
    });

    libreOfficeRemoveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      libreOfficeRemoveBtn.disabled = true;
      libreOfficeRemoveBtn.textContent = "Removing...";
      libreOfficeStatus.textContent = "";
      try {
        const res = await uninstallLibreOfficeShortcut();
        libreOfficeStatus.textContent = res.message;
        libreOfficeStatus.style.color = res.success ? "#4caf50" : "#f44336";
      } catch (err) {
        libreOfficeStatus.textContent = "Error: " + err;
        libreOfficeStatus.style.color = "#f44336";
      }
      libreOfficeRemoveBtn.disabled = false;
      libreOfficeRemoveBtn.textContent = "Remove";
    });

    libreOfficeManualBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const shortcut = libreOfficeShortcutInput.value.trim() || libreOfficeDefaultShortcut;
      libreOfficeStatus.textContent = getLibreOfficeManualInstructions(shortcut);
      libreOfficeStatus.style.color = "";
    });

    libreOfficeBtnRow.appendChild(libreOfficeInstallBtn);
    libreOfficeBtnRow.appendChild(libreOfficeRemoveBtn);
    libreOfficeBtnRow.appendChild(libreOfficeManualBtn);
    libreOfficeSection.appendChild(libreOfficeBtnRow);
    libreOfficeSection.appendChild(libreOfficeStatus);
    form.appendChild(libreOfficeSection);
  }

  modal.appendChild(form);

  // Footer
  const footer = doc.createElement("div");
  footer.className = "edit-modal-footer";

  const cancelBtn = doc.createElement("button");
  cancelBtn.className = "footer-btn";
  cancelBtn.textContent = "Cancel";
  footer.appendChild(cancelBtn);

  const saveBtn = doc.createElement("button");
  saveBtn.className = "footer-btn primary";
  saveBtn.textContent = "Save";
  footer.appendChild(saveBtn);

  modal.appendChild(footer);
  overlay.appendChild(modal);
  doc.body.appendChild(overlay);

  // --- Event handlers ---
  const closeModal = () => {
    overlay.remove();
  };

  const saveAndClose = () => {
    // Save sources
    const newDisabled: string[] = [];
    for (const { id, checkbox } of sourceCheckboxes) {
      if (!checkbox.checked) newDisabled.push(id);
    }
    setDisabledSources(newDisabled);

    // Save other preferences
    for (const pref of PREF_DEFS) {
      const input = inputMap.get(pref.name);
      if (!input) continue;

      if (pref.type === "boolean") {
        setPref(pref.name, (input as HTMLInputElement).checked);
      } else if (pref.type === "number") {
        let val = parseInt((input as HTMLInputElement).value, 10);
        if (isNaN(val)) val = getPref<number>(pref.name);
        if (pref.min !== undefined) val = Math.max(pref.min, val);
        if (pref.max !== undefined) val = Math.min(pref.max, val);
        setPref(pref.name, val);
      } else if (pref.type === "select") {
        setPref(pref.name, (input as HTMLSelectElement).value);
      }
    }

    Zotero.log("[InstantCite] Settings saved");
    closeModal();
    if (onClose) onClose();
  };

  cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); closeModal(); });
  saveBtn.addEventListener("click", (e) => { e.stopPropagation(); saveAndClose(); });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  overlay.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); }
    if (e.key === "Enter" && (e.target as HTMLElement)?.tagName !== "TEXTAREA") {
      e.preventDefault();
      saveAndClose();
    }
  });
}

function createSeparator(doc: Document): HTMLElement {
  const sep = doc.createElement("div");
  sep.className = "settings-separator";
  return sep;
}
