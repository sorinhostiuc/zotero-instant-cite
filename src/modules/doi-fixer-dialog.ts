/**
 * Review dialog for Fix DOIs.
 *
 * A library-wide sweep that both rewrites a field and creates new items is too
 * consequential for a truncated `confirmEx` preview, so every finding is listed
 * with its own checkbox and nothing is written until the user clicks Apply.
 */

import {
  applyDoiFindings,
  scanLibraryForDoiIssues,
  type ApplyOutcome,
  type DoiFinding,
} from "./doi-fixer";

const DIALOG_URL = "chrome://instantcite/content/doifixer.xhtml";
const DIALOG_NAME = "instantcite-doifixer";
const DIALOG_FEATURES = "chrome,centerscreen,resizable=yes,width=920,height=660";

type MainWindowWithOpenDialog = Window & { openDialog: (...args: any[]) => Window };

export function openDoiFixerDialog(mainWindow: MainWindowWithOpenDialog): Window {
  const win = mainWindow.openDialog(DIALOG_URL, DIALOG_NAME, DIALOG_FEATURES);
  win.addEventListener("load", () => { void runDialog(win); }, { once: true } as any);
  return win;
}

async function runDialog(win: Window) {
  const doc = win.document;
  const el = (id: string) => doc.getElementById(id);

  const status = el("doifix-status")!;
  const progressBar = el("doifix-progress-bar") as HTMLElement;
  const list = el("doifix-list")!;
  const summary = el("doifix-summary")!;
  const applyBtn = el("doifix-apply") as HTMLButtonElement;
  const cancelBtn = el("doifix-cancel") as HTMLButtonElement;
  const selectAllBtn = el("doifix-select-all") as HTMLButtonElement;
  const selectNoneBtn = el("doifix-select-none") as HTMLButtonElement;
  const closeBtn = el("doifix-close") as HTMLButtonElement;

  let cancelled = false;
  const cancel = () => { cancelled = true; try { win.close(); } catch { /* ignore */ } };
  cancelBtn.addEventListener("click", cancel);
  closeBtn.addEventListener("click", cancel);
  win.addEventListener("unload", () => { cancelled = true; }, { once: true } as any);

  // --- Scan ---
  let findings: DoiFinding[] = [];
  try {
    findings = await scanLibraryForDoiIssues({
      shouldCancel: () => cancelled,
      onProgress: (done, total, phase) => {
        if (cancelled) return;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        progressBar.style.width = `${pct}%`;
        status.textContent = phase === "resolve"
          ? `Verifying DOIs against CrossRef — ${done} / ${total}`
          : `Searching by title for the real article — ${done} / ${total}`;
      },
    });
  } catch (e: any) {
    status.textContent = `Scan failed: ${e?.message ?? e}`;
    return;
  }

  if (cancelled) return;

  progressBar.style.width = "100%";

  const actionable = findings.filter(f => f.plan);
  const dead = findings.filter(f => !f.plan);

  if (actionable.length === 0) {
    status.textContent = "Scan complete.";
    const empty = doc.createElement("div");
    empty.className = "doifix-empty";
    empty.textContent = dead.length > 0
      ? `No wrong DOIs found. ${dead.length} DOI(s) could not be resolved at all — listed below.`
      : "No wrong DOIs found. Every DOI in the library matches its article.";
    list.appendChild(empty);
    renderDeadRows(doc, list, dead);
    applyBtn.disabled = true;
    summary.textContent = "";
    cancelBtn.textContent = "Close";
    return;
  }

  // --- Review ---
  status.textContent = `Scan complete — ${actionable.length} item(s) with a wrong DOI.`;

  // `repair` is checked by default; `orphan` clears a field, so it opts in.
  const selected = new Set<number>(
    actionable.filter(f => f.plan!.kind === "repair").map(f => f.itemId),
  );

  const updateSummary = () => {
    const chosen = actionable.filter(f => selected.has(f.itemId));
    const created = chosen.filter(f => f.plan!.recoverFrom).length;
    const cleared = chosen.filter(f => f.plan!.clearDoi).length;
    summary.textContent =
      `${chosen.length} selected — ${chosen.length - cleared} DOI(s) corrected, ` +
      `${cleared} cleared, up to ${created} new reference(s) created` +
      (dead.length > 0 ? ` · ${dead.length} unresolvable (not touched)` : "");
    applyBtn.disabled = chosen.length === 0;
  };

  const rows = new Map<number, HTMLElement>();
  for (const finding of actionable) {
    const row = buildRow(doc, finding, selected, updateSummary);
    rows.set(finding.itemId, row);
    list.appendChild(row);
  }
  renderDeadRows(doc, list, dead);

  const setAll = (on: boolean) => {
    selected.clear();
    for (const finding of actionable) {
      if (on) selected.add(finding.itemId);
      const row = rows.get(finding.itemId)!;
      const box = row.querySelector(".doifix-check") as HTMLInputElement;
      box.checked = on;
      row.classList.toggle("selected", on);
    }
    updateSummary();
  };
  selectAllBtn.addEventListener("click", () => setAll(true));
  selectNoneBtn.addEventListener("click", () => setAll(false));

  updateSummary();

  // --- Apply ---
  applyBtn.addEventListener("click", () => {
    void (async () => {
      const chosen = actionable.filter(f => selected.has(f.itemId));
      applyBtn.disabled = true;
      selectAllBtn.disabled = true;
      selectNoneBtn.disabled = true;
      status.textContent = `Applying ${chosen.length} fix(es)…`;
      progressBar.style.width = "0%";

      const outcomes = await applyDoiFindings(chosen);
      if (cancelled) return;

      progressBar.style.width = "100%";
      renderOutcomes(doc, list, status, summary, outcomes);
      cancelBtn.textContent = "Close";
    })();
  });
}

function buildRow(
  doc: Document,
  finding: DoiFinding,
  selected: Set<number>,
  onToggle: () => void,
): HTMLElement {
  const plan = finding.plan!;
  const row = doc.createElement("div");
  row.className = "doifix-row";
  if (selected.has(finding.itemId)) row.classList.add("selected");

  const box = doc.createElement("input") as HTMLInputElement;
  box.type = "checkbox";
  box.className = "doifix-check";
  box.checked = selected.has(finding.itemId);
  box.addEventListener("change", () => {
    if (box.checked) selected.add(finding.itemId);
    else selected.delete(finding.itemId);
    row.classList.toggle("selected", box.checked);
    onToggle();
  });
  row.appendChild(box);

  const body = doc.createElement("div");
  body.className = "doifix-body";

  const title = doc.createElement("div");
  title.className = "doifix-title";
  title.textContent = finding.title;
  title.appendChild(badge(doc, finding.verdict));
  body.appendChild(title);

  const doiLine = doc.createElement("div");
  doiLine.className = "doifix-line";
  doiLine.appendChild(doc.createTextNode("DOI: "));
  const oldSpan = doc.createElement("span");
  oldSpan.className = "doifix-old";
  oldSpan.textContent = plan.oldDoi;
  doiLine.appendChild(oldSpan);
  doiLine.appendChild(doc.createTextNode(" → "));
  const newSpan = doc.createElement("span");
  if (plan.newDoi) {
    newSpan.className = "doifix-new";
    newSpan.textContent = plan.newDoi;
  } else {
    newSpan.className = "doifix-removed";
    newSpan.textContent = "(cleared, tagged for review)";
  }
  doiLine.appendChild(newSpan);
  body.appendChild(doiLine);

  if (finding.resolvedTitle) {
    const wrongLine = doc.createElement("div");
    wrongLine.className = "doifix-line";
    wrongLine.textContent = `Old DOI actually points to: "${finding.resolvedTitle}"`;
    body.appendChild(wrongLine);
  }

  const recoverLine = doc.createElement("div");
  recoverLine.className = "doifix-line";
  recoverLine.textContent = plan.recoverFrom
    ? "→ will be saved as a new reference in this item's collections"
    : "→ no new reference (the old DOI was malformed and never resolved)";
  body.appendChild(recoverLine);

  row.appendChild(body);
  return row;
}

function renderDeadRows(doc: Document, list: Element, dead: DoiFinding[]) {
  for (const finding of dead) {
    const row = doc.createElement("div");
    row.className = "doifix-row readonly";

    const body = doc.createElement("div");
    body.className = "doifix-body";

    const title = doc.createElement("div");
    title.className = "doifix-title";
    title.textContent = finding.title;
    title.appendChild(badge(doc, finding.verdict));
    body.appendChild(title);

    const line = doc.createElement("div");
    line.className = "doifix-line";
    line.textContent = `DOI ${finding.oldDoi} could not be resolved — left untouched.`;
    body.appendChild(line);

    row.appendChild(body);
    list.appendChild(row);
  }
}

function badge(doc: Document, verdict: string): HTMLElement {
  const el = doc.createElement("span");
  el.className = `doifix-badge doifix-badge-${verdict}`;
  el.textContent = verdict;
  return el;
}

function renderOutcomes(
  doc: Document,
  list: Element,
  status: Element,
  summary: Element,
  outcomes: ApplyOutcome[],
) {
  while (list.firstChild) list.removeChild(list.firstChild);

  const corrected = outcomes.filter(o => o.repaired === "doi-corrected" && !o.error).length;
  const cleared = outcomes.filter(o => o.repaired === "doi-cleared" && !o.error).length;
  const created = outcomes.filter(o => o.createdTitle && !o.alreadyPresent && !o.error).length;
  const skipped = outcomes.filter(o => o.alreadyPresent).length;
  const failed = outcomes.filter(o => o.error).length;

  status.textContent = "Done.";
  summary.textContent =
    `${corrected} DOI(s) corrected · ${cleared} cleared · ${created} new reference(s) · ` +
    `${skipped} already in library` + (failed > 0 ? ` · ${failed} failed` : "");

  for (const outcome of outcomes) {
    const row = doc.createElement("div");
    row.className = "doifix-row readonly";

    const body = doc.createElement("div");
    body.className = "doifix-body";

    const title = doc.createElement("div");
    title.className = "doifix-title";
    title.textContent = outcome.title;
    body.appendChild(title);

    const line = doc.createElement("div");
    line.className = "doifix-line";
    line.textContent = outcome.repaired === "doi-corrected"
      ? `DOI set to ${outcome.newDoi}`
      : "DOI cleared and tagged for review";
    body.appendChild(line);

    if (outcome.createdTitle) {
      const created = doc.createElement("div");
      created.className = "doifix-line";
      created.textContent = outcome.alreadyPresent
        ? `Recovered article already in library: "${outcome.createdTitle}"`
        : `New reference created: "${outcome.createdTitle}"`;
      body.appendChild(created);
    }

    if (outcome.error) {
      const err = doc.createElement("div");
      err.className = "doifix-line doifix-removed";
      err.textContent = `Recovery failed: ${outcome.error}`;
      body.appendChild(err);
    }

    row.appendChild(body);
    list.appendChild(row);
  }
}

/** Entry point for the Tools menu. */
export function runDoiFixerWithUI(): void {
  const mainWin = Zotero.getMainWindow() as MainWindowWithOpenDialog | null;
  if (!mainWin) return;
  openDoiFixerDialog(mainWin);
}
