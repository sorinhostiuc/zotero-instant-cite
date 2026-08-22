import type { PaperResult } from "./api/types";

type SelectCallback = (paper: PaperResult, selected: boolean) => void;
type ActionCallback = (paper: PaperResult, action: "addLibrary" | "addCite" | "downloadPdf" | "edit" | "autoUpdate" | "openBrowser", card?: HTMLElement) => void;

export function renderResults(
  doc: Document,
  papers: PaperResult[],
  onSelect: SelectCallback,
  onAction: ActionCallback,
  selectedIds: Set<string>,
  docItemIds?: Set<number>,
) {
  const container = doc.getElementById("results-container");
  if (!container) return;
  container.textContent = "";

  if (papers.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No results found";
    container.appendChild(empty);
    return;
  }

  for (const paper of papers) {
    const isInDocument = docItemIds ? docItemIds.has((paper as any)._zoteroItemId) : false;
    container.appendChild(createResultCard(doc, paper, onSelect, onAction, selectedIds.has(paper.id), isInDocument));
  }
}

function createResultCard(
  doc: Document,
  paper: PaperResult,
  onSelect: SelectCallback,
  onAction: ActionCallback,
  isSelected: boolean,
  isInDocument = false,
): HTMLElement {
  const card = doc.createElement("div");
  card.className = "result-card" + (isSelected ? " selected" : "");

  // Checkbox
  const checkbox = doc.createElement("input") as HTMLInputElement;
  checkbox.type = "checkbox";
  checkbox.className = "result-checkbox";
  checkbox.checked = isSelected;
  checkbox.addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("selected", checkbox.checked);
    onSelect(paper, checkbox.checked);
  });
  card.appendChild(checkbox);

  const content = doc.createElement("div");
  content.className = "result-content";

  // Title
  const title = doc.createElement("div");
  title.className = "result-title";
  title.textContent = paper.title;
  content.appendChild(title);

  // Authors
  const authors = doc.createElement("div");
  authors.className = "result-authors";
  const authorStr = paper.authors.slice(0, 3).map((a) => a.name).join(", ");
  authors.textContent = paper.authors.length > 3 ? `${authorStr} et al.` : authorStr;
  content.appendChild(authors);

  // Meta: Year \u2022 Journal Volume(Issue): Pages
  const meta = doc.createElement("div");
  meta.className = "result-meta";
  const parts: string[] = [];
  if (paper.year) parts.push(String(paper.year));
  if (paper.journal) parts.push(paper.journal);
  // Volume + issue as "Vol. X(Issue Y)" or just "Vol. X" / "Issue Y"
  const volIssue: string[] = [];
  if (paper.volume) volIssue.push(paper.volume);
  if (paper.issue) volIssue.push(`(${paper.issue})`);
  if (volIssue.length > 0) parts.push(volIssue.join(" "));
  if (paper.pages) parts.push(paper.pages);
  meta.textContent = parts.join(" \u2022 ");
  content.appendChild(meta);

  // Badges
  const badges = doc.createElement("div");
  badges.className = "result-badges";
  if (paper.citationCount && paper.citationCount > 0) {
    badges.appendChild(makeBadge(doc, `Cited ${paper.citationCount}x`, "badge-citations"));
  }
  if (paper.isOpenAccess) {
    badges.appendChild(makeBadge(doc, "Open Access", "badge-oa"));
  }
  if (paper.pdfUrl) {
    badges.appendChild(makeBadge(doc, "PDF", "badge-pdf"));
  }
  if (paper.isbn) {
    badges.appendChild(makeBadge(doc, "Book", "badge-book"));
  }
  if (paper.itemType === "case") {
    badges.appendChild(makeBadge(doc, "Case Law", "badge-case"));
  }
  if (paper.itemType === "statute") {
    badges.appendChild(makeBadge(doc, "Legislation", "badge-legislation"));
  }
  if (isInDocument) {
    badges.appendChild(makeBadge(doc, "In Document", "badge-doc"));
  }
  content.appendChild(badges);

  // Identifiers
  const idParts: string[] = [];
  if (paper.pmid) idParts.push("PMID: " + paper.pmid);
  if (paper.doi) idParts.push("DOI: " + paper.doi);
  if (paper.isbn) idParts.push("ISBN: " + paper.isbn);
  if (paper.ecli) idParts.push("ECLI: " + paper.ecli);
  if (paper.celex) idParts.push("CELEX: " + paper.celex);
  if (paper.caseNumber) idParts.push("App. No. " + paper.caseNumber);
  if (idParts.length > 0) {
    const ids = doc.createElement("div");
    ids.className = "result-identifiers";
    ids.textContent = idParts.join(" \u2022 ");
    content.appendChild(ids);
  }

  // Sources
  const sources = doc.createElement("div");
  sources.className = "result-sources";
  sources.textContent = "Found in: " + paper.sources.join(", ");
  content.appendChild(sources);

  // Abstract (visible preview + expandable full text)
  if (paper.abstract) {
    const PREVIEW_LEN = 200;
    const isLong = paper.abstract.length > PREVIEW_LEN;

    const abstractDiv = doc.createElement("div");
    abstractDiv.className = "result-abstract";
    abstractDiv.textContent = isLong
      ? paper.abstract.slice(0, PREVIEW_LEN) + "..."
      : paper.abstract;
    content.appendChild(abstractDiv);

    if (isLong) {
      const toggle = doc.createElement("button");
      toggle.className = "abstract-toggle";
      toggle.textContent = "Show full abstract";
      let expanded = false;
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        expanded = !expanded;
        abstractDiv.textContent = expanded ? paper.abstract! : paper.abstract!.slice(0, PREVIEW_LEN) + "...";
        toggle.textContent = expanded ? "Show less" : "Show full abstract";
      });
      content.appendChild(toggle);
    }
  }

  // Action buttons
  const actions = doc.createElement("div");
  actions.className = "result-actions";

  actions.appendChild(makeBtn(doc, "Add to Library", (e) => {
    e.stopPropagation();
    onAction(paper, "addLibrary");
    (e.target as HTMLElement).textContent = "Added!";
    (e.target as HTMLElement).style.color = "#388e3c";
  }));

  actions.appendChild(makeBtn(doc, "Edit", (e) => {
    e.stopPropagation();
    onAction(paper, "edit", card);
  }));

  actions.appendChild(makeBtn(doc, "AutoUpdate", (e) => {
    e.stopPropagation();
    onAction(paper, "autoUpdate", card);
  }));

  // Show download button: explicit PDF URL, or OA, or has DOI (Zotero can try Unpaywall)
  if (paper.pdfUrl || paper.isOpenAccess || paper.doi) {
    const label = paper.pdfUrl ? "Download PDF" : (paper.isOpenAccess ? "Find PDF (OA)" : "Find PDF");
    actions.appendChild(makeBtn(doc, label, (e) => {
      e.stopPropagation();
      const btn = e.target as HTMLElement;
      btn.textContent = "Downloading...";
      btn.style.pointerEvents = "none";
      onAction(paper, "downloadPdf", card);
    }));
  }

  // Open button — opens PDF locally if downloaded, otherwise opens in browser
  if (paper.doi || paper.pdfUrl || paper.url) {
    actions.appendChild(makeBtn(doc, "Open in Browser", (e) => {
      e.stopPropagation();
      onAction(paper, "openBrowser", card);
    }));
  }

  content.appendChild(actions);

  // Click card = toggle select
  card.addEventListener("click", (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "BUTTON" || tag === "INPUT") return;
    checkbox.checked = !checkbox.checked;
    card.classList.toggle("selected", checkbox.checked);
    onSelect(paper, checkbox.checked);
  });

  card.appendChild(content);
  return card;
}

function makeBadge(doc: Document, text: string, cls: string): HTMLElement {
  const el = doc.createElement("span");
  el.className = "result-badge " + cls;
  el.textContent = text;
  return el;
}

function makeBtn(doc: Document, label: string, onClick: (e: Event) => void, primary = false): HTMLElement {
  const btn = doc.createElement("button");
  btn.className = primary ? "action-btn primary" : "action-btn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

export function clearResults(doc: Document) {
  const c = doc.getElementById("results-container");
  if (c) c.textContent = "";
}

export function showLoading(doc: Document) {
  const c = doc.getElementById("results-container");
  if (!c) return;
  c.textContent = "";
  const wrap = doc.createElement("div");
  wrap.className = "loading";
  const spinner = doc.createElement("div");
  spinner.className = "loading-spinner";
  const text = doc.createElement("div");
  text.textContent = "Searching all sources...";
  wrap.appendChild(spinner);
  wrap.appendChild(text);
  c.appendChild(wrap);
}

export function hideLoading(_doc: Document) {}

export function updateSourceTabs(doc: Document, counts: Record<string, number>, total: number) {
  const allBadge = doc.querySelector('.tab[data-source="all"] .badge');
  if (allBadge) allBadge.textContent = String(total);

  for (const [source, count] of Object.entries(counts)) {
    const badge = doc.querySelector('.tab[data-source="' + source + '"] .badge');
    if (badge) badge.textContent = String(count);
  }
}
