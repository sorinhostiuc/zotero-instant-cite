/**
 * Merge dialog — minimal modal overlay for choosing master + confirming merge.
 *
 * Manual override mode: no automatic blocking on author/DOI mismatch.
 * Shows non-blocking warning lines for things worth checking, but the user
 * always has final say.
 */

import { mergeItems, scoreItemForMaster } from "./dedup-manager";

interface MergeOptions {
  /** Items selected by user — must all be from the local Zotero library */
  items: Zotero.Item[];
  /** Called after a successful merge with the master item */
  onMerged?: (master: Zotero.Item) => void;
}

export function openMergeDialog(doc: Document, opts: MergeOptions) {
  if (opts.items.length < 2) return;

  const overlay = doc.createElement("div");
  overlay.className = "edit-overlay";

  const modal = doc.createElement("div");
  modal.className = "edit-modal";
  modal.style.cssText = "max-width:680px;";

  // --- Header ---
  const header = doc.createElement("div");
  header.className = "edit-modal-header";
  header.textContent = "Merge " + opts.items.length + " items";
  modal.appendChild(header);

  const form = doc.createElement("div");
  form.className = "edit-modal-form";

  // --- Intro line ---
  const intro = doc.createElement("div");
  intro.className = "settings-description";
  intro.textContent =
    "Choose the master item. The other " + (opts.items.length - 1) +
    " will be moved to Trash. Empty fields on master will be filled from secondaries.";
  form.appendChild(intro);

  // --- Non-blocking warnings ---
  const warnings = collectWarnings(opts.items);
  if (warnings.length > 0) {
    const warnBox = doc.createElement("div");
    warnBox.style.cssText =
      "margin-top:10px;padding:8px 12px;background:#fff3e0;border-left:3px solid #ff9800;" +
      "font-size:13px;color:#5d4037;";
    for (const w of warnings) {
      const line = doc.createElement("div");
      line.textContent = "⚠ " + w;
      warnBox.appendChild(line);
    }
    form.appendChild(warnBox);
  }

  // --- Master picker ---
  const pickerHeader = doc.createElement("div");
  pickerHeader.className = "settings-section-title";
  pickerHeader.style.cssText = "margin-top:14px;";
  pickerHeader.textContent = "Master";
  form.appendChild(pickerHeader);

  // Score each item, sort highest first, suggest top
  const scored = opts.items.map(it => ({ item: it, score: scoreItemForMaster(it) }));
  scored.sort((a, b) => b.score - a.score);
  let selectedMasterId: number = scored[0].item.id;

  for (const { item, score } of scored) {
    const row = doc.createElement("label");
    row.style.cssText =
      "display:flex;gap:10px;align-items:flex-start;padding:8px;margin-top:4px;" +
      "border:1px solid #ddd;border-radius:4px;cursor:pointer;";

    const radio = doc.createElement("input") as HTMLInputElement;
    radio.type = "radio";
    radio.name = "merge-master";
    radio.value = String(item.id);
    radio.checked = item.id === selectedMasterId;
    radio.style.marginTop = "4px";
    radio.addEventListener("change", () => {
      if (radio.checked) selectedMasterId = item.id;
    });
    row.appendChild(radio);

    const info = doc.createElement("div");
    info.style.cssText = "flex:1;min-width:0;";

    const titleEl = doc.createElement("div");
    titleEl.style.cssText = "font-weight:600;color:#1a73e8;";
    titleEl.textContent = (item.getField("title") as string) || "(no title)";
    info.appendChild(titleEl);

    const meta = doc.createElement("div");
    meta.style.cssText = "font-size:12px;color:#555;margin-top:2px;";
    meta.textContent = describeItem(item, score);
    info.appendChild(meta);

    row.appendChild(info);
    form.appendChild(row);
  }

  // --- Refresh-Word reminder ---
  const reminder = doc.createElement("div");
  reminder.style.cssText =
    "margin-top:14px;padding:8px 12px;background:#e3f2fd;border-left:3px solid #2196f3;" +
    "font-size:13px;color:#0d47a1;";
  const reminderStrong = doc.createElement("strong");
  reminderStrong.textContent = "After merge: ";
  reminder.appendChild(reminderStrong);
  reminder.appendChild(doc.createTextNode(
    "open any Word document using these references and click "
  ));
  const refreshEm = doc.createElement("em");
  refreshEm.textContent = "Add-ins → Zotero → Refresh";
  reminder.appendChild(refreshEm);
  reminder.appendChild(doc.createTextNode(" "));
  const beforeStrong = doc.createElement("strong");
  beforeStrong.textContent = "before emptying Trash";
  reminder.appendChild(beforeStrong);
  reminder.appendChild(doc.createTextNode(
    ". Citations auto-redirect to the new master."
  ));
  form.appendChild(reminder);

  modal.appendChild(form);

  // --- Footer ---
  const footer = doc.createElement("div");
  footer.className = "edit-modal-footer";

  const cancelBtn = doc.createElement("button");
  cancelBtn.className = "footer-btn";
  cancelBtn.textContent = "Cancel";
  footer.appendChild(cancelBtn);

  const mergeBtn = doc.createElement("button");
  mergeBtn.className = "footer-btn primary";
  mergeBtn.textContent = "Merge";
  footer.appendChild(mergeBtn);

  modal.appendChild(footer);
  overlay.appendChild(modal);
  doc.body.appendChild(overlay);

  const close = () => overlay.remove();

  cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); close(); });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  mergeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    mergeBtn.disabled = true;
    cancelBtn.disabled = true;
    mergeBtn.textContent = "Merging…";
    try {
      const master = opts.items.find(it => it.id === selectedMasterId);
      if (!master) throw new Error("Master item not found");
      const secondaries = opts.items.filter(it => it.id !== selectedMasterId);
      await mergeItems(master, secondaries);
      close();
      if (opts.onMerged) opts.onMerged(master);
    } catch (err) {
      Zotero.log("[InstantCite] Merge failed: " + err);
      mergeBtn.textContent = "Merge failed — see Zotero log";
      mergeBtn.style.color = "#d32f2f";
      cancelBtn.disabled = false;
    }
  });
}

/** Collect non-blocking warnings — things worth flagging but never blocking. */
function collectWarnings(items: Zotero.Item[]): string[] {
  const warnings: string[] = [];

  // Different DOIs
  const dois = new Set<string>();
  for (const it of items) {
    try {
      const d = String(it.getField("DOI") || "").trim().toLowerCase();
      if (d) dois.add(d);
    } catch { /* */ }
  }
  if (dois.size > 1) {
    warnings.push("Items have " + dois.size + " different DOIs — confirm they're the same publication.");
  }

  // Different ISBNs
  const isbns = new Set<string>();
  for (const it of items) {
    try {
      const s = String(it.getField("ISBN") || "").replace(/[^0-9X]/gi, "");
      if (s) isbns.add(s);
    } catch { /* */ }
  }
  if (isbns.size > 1) {
    warnings.push("Items have " + isbns.size + " different ISBNs.");
  }

  // Different item types
  const types = new Set<string>();
  for (const it of items) {
    try {
      const t = Zotero.ItemTypes.getName(it.itemTypeID);
      if (t) types.add(t);
    } catch { /* */ }
  }
  if (types.size > 1) {
    warnings.push("Items are of different types: " + Array.from(types).join(", ") + ".");
  }

  return warnings;
}

/** Compact one-line description for a candidate row. */
function describeItem(item: Zotero.Item, score: number): string {
  const parts: string[] = [];

  // First creator
  const creators = item.getCreators();
  if (creators.length > 0) {
    const c = creators[0];
    const surname = (c.lastName || c.firstName || "").trim();
    if (surname) parts.push(surname + (creators.length > 1 ? " et al." : ""));
  }

  // Year
  const date = String(item.getField("date") || "");
  const yearMatch = date.match(/\d{4}/);
  if (yearMatch) parts.push(yearMatch[0]);

  // PDF/attachment count
  let pdfCount = 0;
  let otherCount = 0;
  for (const attId of item.getAttachments()) {
    const att = Zotero.Items.get(attId);
    if (!att) continue;
    if (att.attachmentContentType === "application/pdf") pdfCount++;
    else otherCount++;
  }
  if (pdfCount > 0) parts.push(pdfCount + " PDF" + (pdfCount > 1 ? "s" : ""));
  if (otherCount > 0) parts.push(otherCount + " link" + (otherCount > 1 ? "s" : ""));

  // Collections
  const collCount = item.getCollections().length;
  if (collCount > 0) parts.push(collCount + " collection" + (collCount > 1 ? "s" : ""));

  // Score (helpful to see why a candidate was auto-suggested)
  parts.push("score " + score);

  return parts.join(" · ");
}
