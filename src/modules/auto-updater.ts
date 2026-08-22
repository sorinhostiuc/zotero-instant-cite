/**
 * AutoUpdate — search external APIs for metadata improvements and apply them.
 *
 * Core exports:
 * - mergePaperFields(current, match): FieldDiff[]  — pure, testable
 * - findAndMergeUpdates(paper): Promise<AutoUpdateResult>
 * - applyAutoUpdates(zoteroItem, result, mode, acceptedFields?): FieldDiff[]
 * - showPreviewModal(doc, diffs, legMatch, legFields): Promise<Set<string> | null>
 */

import type { PaperResult, SearchOptions } from "./api/types";
import { orchestrateSearch } from "./search-orchestrator";
import { normalizeForSearch } from "./utils/text-normalizer";
import { titleSimilarity } from "./utils/deduplicator";
import { isWellFormedDoi, sameDoi, titlesAgree } from "./utils/doi";
import {
  isLegislativeReference,
  parseLegislativeReference,
  applyLegislativeFormatting,
} from "./utils/legislative-detector";
import type { LegislativeMatch, LegislativeFields } from "./utils/legislative-detector";
import { addToZotero, isCorporateAuthor, parseAuthorName } from "./zotero-bridge";
import { fixItemCreators } from "./creator-fixer";
import { getAutoUpdateMode, getAutoUpdateSortOrder } from "./preferences";
import { lookupCrossRefDOI, searchCrossRef } from "./api/crossref";
import { searchEuropePMC } from "./api/europepmc";
import { searchPubMed } from "./api/pubmed";
import { searchDOAJ } from "./api/doaj";
import { searchOpenLibrary } from "./api/open-library";
import { searchGoogleBooks } from "./api/google-books";
import type { AutoUpdateMode } from "./preferences";

// ─── Types ─────────────────────────────────────────────────────────────

export interface FieldDiff {
  field: string;
  oldValue: string;
  newValue: string;
  isNew: boolean; // true if old was empty
}

export interface AutoUpdateResult {
  diffs: FieldDiff[];
  legislativeMatch: LegislativeMatch | null;
  legislativeFields: LegislativeFields | null;
  mergedPaper: PaperResult;
}

// ─── mergePaperFields (pure, testable) ─────────────────────────────────

/**
 * Compare two PaperResults field-by-field, returning diffs where `match`
 * has strictly better data than `current`.
 */
export function mergePaperFields(current: PaperResult, match: PaperResult): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  // title — longer wins, but ignore truncated titles (trailing "...")
  if (isBetterTitle(match.title, current.title)) {
    diffs.push({
      field: "title",
      oldValue: current.title,
      newValue: match.title,
      isNew: !current.title,
    });
  }

  // authors — more authors wins
  if (match.authors.length > current.authors.length) {
    diffs.push({
      field: "authors",
      oldValue: current.authors.map(a => a.name).join("; "),
      newValue: match.authors.map(a => a.name).join("; "),
      isNew: current.authors.length === 0,
    });
  }

  // year — present over absent
  if (!current.year && match.year) {
    diffs.push({
      field: "year",
      oldValue: "",
      newValue: String(match.year),
      isNew: true,
    });
  }

  // journal — present over absent; longer
  if (isBetterString(match.journal, current.journal)) {
    diffs.push({
      field: "journal",
      oldValue: current.journal ?? "",
      newValue: match.journal!,
      isNew: !current.journal,
    });
  }

  // doi — present over absent
  if (!current.doi && match.doi) {
    diffs.push({
      field: "doi",
      oldValue: "",
      newValue: match.doi,
      isNew: true,
    });
  }

  // pmid — present over absent
  if (!current.pmid && match.pmid) {
    diffs.push({
      field: "pmid",
      oldValue: "",
      newValue: match.pmid,
      isNew: true,
    });
  }

  // isbn — present over absent
  if (!current.isbn && match.isbn) {
    diffs.push({
      field: "isbn",
      oldValue: "",
      newValue: match.isbn,
      isNew: true,
    });
  }

  // abstract — present over absent; longer (>1.2x)
  if (isBetterAbstract(match.abstract, current.abstract)) {
    diffs.push({
      field: "abstract",
      oldValue: current.abstract ?? "",
      newValue: match.abstract!,
      isNew: !current.abstract,
    });
  }

  // volume — present over absent
  if (!current.volume && match.volume) {
    diffs.push({
      field: "volume",
      oldValue: "",
      newValue: match.volume,
      isNew: true,
    });
  }

  // issue — present over absent
  if (!current.issue && match.issue) {
    diffs.push({
      field: "issue",
      oldValue: "",
      newValue: match.issue,
      isNew: true,
    });
  }

  // pages — present over absent
  if (!current.pages && match.pages) {
    diffs.push({
      field: "pages",
      oldValue: "",
      newValue: match.pages,
      isNew: true,
    });
  }

  // journalAbbreviation — present over absent
  if (!current.journalAbbreviation && match.journalAbbreviation) {
    diffs.push({
      field: "journalAbbreviation",
      oldValue: "",
      newValue: match.journalAbbreviation,
      isNew: true,
    });
  }

  // issn — present over absent
  if (!current.issn && match.issn) {
    diffs.push({
      field: "issn",
      oldValue: "",
      newValue: match.issn,
      isNew: true,
    });
  }

  // citationCount — higher value
  if (
    match.citationCount !== undefined &&
    match.citationCount > (current.citationCount ?? 0)
  ) {
    diffs.push({
      field: "citationCount",
      oldValue: String(current.citationCount ?? 0),
      newValue: String(match.citationCount),
      isNew: current.citationCount === undefined,
    });
  }

  // isOpenAccess — true over false
  if (match.isOpenAccess && !current.isOpenAccess) {
    diffs.push({
      field: "isOpenAccess",
      oldValue: "false",
      newValue: "true",
      isNew: false,
    });
  }

  // pdfUrl — present over absent
  if (!current.pdfUrl && match.pdfUrl) {
    diffs.push({
      field: "pdfUrl",
      oldValue: "",
      newValue: match.pdfUrl,
      isNew: true,
    });
  }

  // publisher — present over absent
  if (!current.publisher && match.publisher) {
    diffs.push({ field: "publisher", oldValue: "", newValue: match.publisher, isNew: true });
  }

  // place — present over absent
  if (!current.place && match.place) {
    diffs.push({ field: "place", oldValue: "", newValue: match.place, isNew: true });
  }

  return diffs;
}

// ─── Helpers for comparison ────────────────────────────────────────────

function isTruncated(title: string): boolean {
  return title.endsWith("...");
}

function isBetterTitle(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate) return false;
  if (!current) return !!candidate;
  if (isTruncated(candidate)) return false;
  // Candidate must be strictly longer
  return candidate.length > current.length;
}

function isBetterString(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return candidate.length > current.length;
}

function isBetterAbstract(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate) return false;
  if (!current) return true;
  // Must be significantly longer (>1.2x)
  return candidate.length > current.length * 1.2;
}

// ─── findAndMergeUpdates ───────────────────────────────────────────────

/**
 * Search all APIs for the given paper, merge best fields, detect legislative refs.
 */
export async function findAndMergeUpdates(paper: PaperResult): Promise<AutoUpdateResult> {
  const matches: PaperResult[] = [];

  // Search by direct identifiers first
  const queries: string[] = [];
  if (paper.doi) queries.push(paper.doi);
  if (paper.pmid) queries.push(paper.pmid);
  if (paper.isbn) queries.push(paper.isbn);
  // Fall back to title search
  if (queries.length === 0 && paper.title) {
    queries.push(normalizeForSearch(paper.title));
  }

  for (const query of queries) {
    try {
      const result = await orchestrateSearch({
        query,
        maxResults: 20,
      });
      for (const p of result.papers) {
        if (isLikelyMatch(paper, p)) {
          matches.push(p);
        }
      }
    } catch {
      // Skip failed searches
    }
  }

  // Accumulate best per field across all matches
  const allDiffs = new Map<string, FieldDiff>();
  for (const match of matches) {
    const diffs = mergePaperFields(paper, match);
    for (const diff of diffs) {
      // Keep last (usually best) diff per field
      allDiffs.set(diff.field, diff);
    }
  }

  // Build merged paper
  const mergedPaper: PaperResult = { ...paper };
  for (const diff of allDiffs.values()) {
    applyDiffToPaper(mergedPaper, diff);
  }

  // Legislative detection on merged result
  const legislativeMatch = isLegislativeReference(mergedPaper.title);
  let legislativeFields: LegislativeFields | null = null;
  if (legislativeMatch) {
    legislativeFields = parseLegislativeReference(mergedPaper.title, legislativeMatch);
  }

  return {
    diffs: [...allDiffs.values()],
    legislativeMatch,
    legislativeFields,
    mergedPaper,
  };
}

function isLikelyMatch(paper: PaperResult, candidate: PaperResult): boolean {
  // Match by DOI
  if (paper.doi && candidate.doi && paper.doi.toLowerCase() === candidate.doi.toLowerCase()) {
    return true;
  }
  // Match by PMID
  if (paper.pmid && candidate.pmid && paper.pmid === candidate.pmid) {
    return true;
  }
  // Match by ISBN
  if (paper.isbn && candidate.isbn && paper.isbn === candidate.isbn) {
    return true;
  }
  // Match by title similarity
  if (paper.title && candidate.title && titleSimilarity(paper.title, candidate.title) > 0.90) {
    return true;
  }
  return false;
}

function applyDiffToPaper(paper: PaperResult, diff: FieldDiff): void {
  switch (diff.field) {
    case "title":
      paper.title = diff.newValue;
      break;
    case "authors":
      // Authors are serialized as "Name1; Name2" — parse back
      paper.authors = diff.newValue.split("; ").map(name => ({ name }));
      break;
    case "year":
      paper.year = parseInt(diff.newValue, 10);
      break;
    case "journal":
      paper.journal = diff.newValue;
      break;
    case "doi":
      paper.doi = diff.newValue;
      break;
    case "pmid":
      paper.pmid = diff.newValue;
      break;
    case "isbn":
      paper.isbn = diff.newValue;
      break;
    case "abstract":
      paper.abstract = diff.newValue;
      break;
    case "citationCount":
      paper.citationCount = parseInt(diff.newValue, 10);
      break;
    case "isOpenAccess":
      paper.isOpenAccess = diff.newValue === "true";
      break;
    case "pdfUrl":
      paper.pdfUrl = diff.newValue;
      break;
    case "volume":
      paper.volume = diff.newValue;
      break;
    case "issue":
      paper.issue = diff.newValue;
      break;
    case "pages":
      paper.pages = diff.newValue;
      break;
    case "journalAbbreviation":
      paper.journalAbbreviation = diff.newValue;
      break;
    case "issn":
      paper.issn = diff.newValue;
      break;
    case "publisher":
      paper.publisher = diff.newValue;
      break;
    case "place":
      paper.place = diff.newValue;
      break;
  }
}

// ─── applyAutoUpdates ──────────────────────────────────────────────────

/**
 * Apply diffs to a Zotero item based on the selected mode.
 * Returns any diffs that still need user review (for preview/hybrid).
 */
export function applyAutoUpdates(
  zoteroItem: any,
  result: AutoUpdateResult,
  mode: AutoUpdateMode,
  acceptedFields?: Set<string>,
): FieldDiff[] {
  const needsReview: FieldDiff[] = [];

  for (const diff of result.diffs) {
    const shouldApply =
      mode === "silent" ||
      (acceptedFields
        ? acceptedFields.has(diff.field)
        : (mode === "hybrid" && diff.isNew));

    if (shouldApply) {
      applyDiffToItem(zoteroItem, diff, result.mergedPaper);
    } else {
      needsReview.push(diff);
    }
  }

  // Apply legislative formatting if accepted
  if (
    result.legislativeMatch &&
    result.legislativeFields &&
    (mode === "silent" || (acceptedFields && acceptedFields.has("legislative")))
  ) {
    applyLegislativeFormatting(zoteroItem, result.legislativeFields);
  }

  // Always fix creators (corporate detection, name inversions) — independent of diffs
  const creatorFixes = fixItemCreators(zoteroItem);
  if (creatorFixes.length > 0) {
    for (const fix of creatorFixes) {
      needsReview.push({
        field: "creators",
        oldValue: "",
        newValue: fix,
        isNew: false,
      });
    }
  }

  return needsReview;
}

function applyDiffToItem(
  item: any,
  diff: FieldDiff,
  mergedPaper: PaperResult,
): void {
  switch (diff.field) {
    case "title":
      item.setField("title", diff.newValue);
      break;
    case "year":
      item.setField("date", diff.newValue);
      break;
    case "journal": {
      const itemType = item.itemTypeID === Zotero.ItemTypes.getID("book")
        ? "publisher" : "publicationTitle";
      item.setField(itemType, diff.newValue);
      break;
    }
    case "doi":
      item.setField("DOI", diff.newValue);
      break;
    case "abstract":
      item.setField("abstractNote", diff.newValue);
      break;
    case "isbn":
      item.setField("ISBN", diff.newValue);
      break;
    case "pmid": {
      const extra = (item.getField("extra") ?? "") as string;
      if (!extra.includes("PMID:")) {
        item.setField("extra", extra ? extra + "\nPMID: " + diff.newValue : "PMID: " + diff.newValue);
      }
      break;
    }
    case "citationCount": {
      const extra = (item.getField("extra") ?? "") as string;
      const updated = extra.replace(/Citations: \d+/, "Citations: " + diff.newValue);
      if (updated === extra) {
        // Not found — append
        item.setField("extra", extra ? extra + "\nCitations: " + diff.newValue : "Citations: " + diff.newValue);
      } else {
        item.setField("extra", updated);
      }
      break;
    }
    case "authors": {
      // Clear existing creators and set new ones
      const numCreators = item.getCreators().length;
      for (let i = numCreators - 1; i >= 0; i--) {
        item.removeCreator(i);
      }
      for (const author of mergedPaper.authors) {
        const idx = item.getCreators().length;
        if (isCorporateAuthor(author.name)) {
          item.setCreator(idx, {
            lastName: author.name,
            creatorType: "author",
            fieldMode: 1,
          } as any);
        } else {
          const { lastName, firstName } = parseAuthorName(author.name);
          item.setCreator(idx, {
            firstName,
            lastName,
            creatorType: "author",
          });
        }
      }
      break;
    }
    case "volume":
      item.setField("volume", diff.newValue);
      break;
    case "issue":
      item.setField("issue", diff.newValue);
      break;
    case "pages":
      item.setField("pages", diff.newValue);
      break;
    case "journalAbbreviation":
      try { item.setField("journalAbbreviation", diff.newValue); } catch { /* may not exist */ }
      break;
    case "issn":
      try { item.setField("ISSN", diff.newValue); } catch { /* may not exist */ }
      break;
    case "publisher":
      item.setField("publisher", diff.newValue);
      break;
    case "place":
      try { item.setField("place", diff.newValue); } catch { /* may not exist */ }
      break;
    // isOpenAccess and pdfUrl don't map to Zotero fields directly
  }
}

// ─── showPreviewModal ──────────────────────────────────────────────────

/**
 * Show a modal overlay letting the user accept/reject individual field updates.
 * Returns the set of accepted field names, or null if cancelled.
 */
export function showPreviewModal(
  doc: Document,
  diffs: FieldDiff[],
  legMatch: LegislativeMatch | null,
  legFields: LegislativeFields | null,
  mode?: AutoUpdateMode,
): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    // Build overlay
    const overlay = doc.createElement("div");
    overlay.id = "instantcite-autoupdate-overlay";
    overlay.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);" +
      "z-index:10000;display:flex;align-items:center;justify-content:center;";

    const modal = doc.createElement("div");
    modal.style.cssText =
      "background:#fff;border-radius:8px;padding:20px;max-width:600px;width:90%;" +
      "max-height:80vh;overflow-y:auto;font-family:system-ui,sans-serif;";

    const title = doc.createElement("h3");
    const totalChanges = diffs.length + (legMatch ? 1 : 0);
    title.textContent = "AutoUpdate — Review Changes (" + totalChanges + ")";
    title.style.cssText = "margin:0 0 12px 0;font-size:16px;";
    modal.appendChild(title);

    const checkboxes: Array<{ field: string; cb: HTMLInputElement }> = [];

    // Diff rows
    for (const diff of diffs) {
      const row = doc.createElement("label");
      row.style.cssText =
        "display:flex;align-items:flex-start;gap:8px;padding:6px 0;" +
        "border-bottom:1px solid #eee;cursor:pointer;";

      const cb = doc.createElement("input") as HTMLInputElement;
      cb.type = "checkbox";
      cb.checked = mode === "hybrid" ? diff.isNew : true;
      cb.style.marginTop = "3px";
      row.appendChild(cb);
      checkboxes.push({ field: diff.field, cb });

      const info = doc.createElement("div");
      info.style.flex = "1";

      const fieldLabel = doc.createElement("strong");
      fieldLabel.textContent = diff.field + (diff.isNew ? " (new)" : "");
      info.appendChild(fieldLabel);

      if (!diff.isNew && diff.oldValue) {
        const oldSpan = doc.createElement("div");
        oldSpan.style.cssText = "text-decoration:line-through;color:#999;font-size:13px;";
        oldSpan.textContent = truncateDisplay(diff.oldValue);
        info.appendChild(oldSpan);
      }

      const arrow = doc.createElement("div");
      arrow.style.cssText = "color:#2a7;font-size:13px;";
      arrow.textContent = "-> " + truncateDisplay(diff.newValue);
      info.appendChild(arrow);

      row.appendChild(info);
      modal.appendChild(row);
    }

    // Legislative row
    if (legMatch && legFields) {
      const row = doc.createElement("label");
      row.style.cssText =
        "display:flex;align-items:flex-start;gap:8px;padding:6px 0;" +
        "border-bottom:1px solid #eee;cursor:pointer;";

      const cb = doc.createElement("input") as HTMLInputElement;
      cb.type = "checkbox";
      cb.checked = mode !== "hybrid";
      cb.style.marginTop = "3px";
      row.appendChild(cb);
      checkboxes.push({ field: "legislative", cb });

      const info = doc.createElement("div");
      info.style.flex = "1";

      const fieldLabel = doc.createElement("strong");
      fieldLabel.textContent = "Legislative reference detected";
      info.appendChild(fieldLabel);

      const detail = doc.createElement("div");
      detail.style.cssText = "color:#2a7;font-size:13px;";
      detail.textContent =
        `${legMatch.jurisdiction} ${legMatch.subType}` +
        (legFields.codeNumber ? ` — ${legFields.codeNumber}` : "");
      info.appendChild(detail);

      row.appendChild(info);
      modal.appendChild(row);
    }

    // Buttons
    const btnRow = doc.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:16px;";

    const cancelBtn = doc.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "padding:6px 16px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;";
    cancelBtn.onclick = () => {
      overlay.remove();
      resolve(null);
    };

    const applyBtn = doc.createElement("button");
    applyBtn.textContent = "Apply Selected";
    applyBtn.style.cssText =
      "padding:6px 16px;border:none;border-radius:4px;background:#2a7;color:#fff;cursor:pointer;";
    applyBtn.onclick = () => {
      const accepted = new Set<string>();
      for (const { field, cb } of checkboxes) {
        if (cb.checked) accepted.add(field);
      }
      overlay.remove();
      resolve(accepted);
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(applyBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);

    // Escape closes the preview, stopPropagation prevents window-level handler from
    // cancelling the entire integration session
    overlay.addEventListener("keydown", (e: Event) => {
      const ke = e as KeyboardEvent;
      ke.stopPropagation();
      if (ke.key === "Escape") {
        ke.preventDefault();
        overlay.remove();
        resolve(null);
      }
    });

    doc.body.appendChild(overlay);
  });
}

function truncateDisplay(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

// ─── Library Batch AutoUpdate ──────────────────────────────────────────

interface BatchUpdateResult {
  itemId: number;
  title: string;
  doi: string;
  added: string[];
  changed: string[];  // verify mode: existing values that were corrected
  itemType: string;   // "journalArticle" | "book"
  error?: string;
  /** Identifier lookups that resolved to a different article — nothing applied from them. */
  conflicts?: string[];
}

/** How a candidate record was tied to the item. Only "title" may rewrite the DOI. */
type MatchedBy = "doi" | "pmid" | "isbn" | "title";

/** Fields checked for each item type */
const JOURNAL_FIELDS = ["volume", "issue", "pages", "journal", "issn", "journalAbbreviation"] as const;
const BOOK_FIELDS = ["publisher", "place", "year", "isbn"] as const;

/**
 * Find a matching paper across ALL InstantCite databases AND merge data
 * from multiple sources to get the most complete metadata.
 *
 * Strategy:
 * 1. Find primary match (DOI → PMID → ISBN → title)
 * 2. If primary match has missing volume/issue/pages, try supplementary sources
 * 3. Merge the best data from all available sources
 */
async function findMatch(
  item: any,
  itemType: string,
): Promise<{ paper: any | null; source: string; matchedBy: MatchedBy; conflicts: string[] } | null> {
  const doi = normalizeDOI((item.getField("DOI") as string));
  const pmid = (item.getField("extra") as string)?.match(/PMID:\s*(\d+)/)?.[1] || "";
  const isbn = (item.getField("ISBN") as string)?.trim();
  const title = (item.getField("title") as string)?.trim();
  const cleanQuery = title ? title.slice(0, 100).replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim() : "";

  let bestPaper: any = null;
  let bestSource = "";
  let hasCrossrefMatch = false;
  let matchedBy: MatchedBy = "title";
  const conflicts: string[] = [];

  /**
   * A record fetched by identifier is authoritative about its own article, not
   * about this item. Reject it when the titles describe different works —
   * otherwise a single wrong DOI rewrites journal, year, volume and pages.
   */
  const verify = (candidate: any, src: string): boolean => {
    if (!candidate) return false;
    if (titlesAgree(title, candidate.title)) return true;
    conflicts.push(
      `${src} → "${String(candidate.title || "?").slice(0, 70)}"` +
      (candidate.doi ? ` (${candidate.doi})` : ""),
    );
    return false;
  };

  // Helper: check if a paper is "incomplete" (missing journal-critical fields)
  const isIncomplete = (p: any): boolean => {
    if (!p) return true;
    // For journal articles and book chapters, check volume + pages
    const hasVolume = !!(p.volume ?? p.journalVolume);
    const hasPages = !!(p.pages ?? p.pageInfo ?? p.page);
    return !hasVolume || !hasPages;
  };

  // Helper: merge supplementary data into primary paper
  // Checks both PaperResult-mapped fields AND raw API fields
  const mergeInto = (primary: any, supplement: any): void => {
    if (!primary || !supplement) return;
    // Use the first non-empty value from either naming convention
    const pick = (field: string, ...aliases: string[]): string | undefined => {
      for (const alias of [field, ...aliases]) {
        const val = (supplement as any)[alias];
        if (val && String(val).trim()) return String(val).trim();
      }
      return undefined;
    };

    if (!primary.volume) {
      primary.volume = pick("volume", "journalVolume");
    }
    if (!primary.issue) {
      primary.issue = pick("issue");
    }
    if (!primary.pages) {
      primary.pages = pick("pages", "pageInfo", "page");
      // Also try start_page + end_page
      if (!primary.pages) {
        const sp = pick("start_page", "startPage");
        const ep = pick("end_page", "endPage");
        if (sp) primary.pages = sp + (ep ? "-" + ep : "");
      }
    }
    if (!primary.issn) {
      primary.issn = pick("issn", "journalIssn");
    }
    if (!primary.pmid) {
      primary.pmid = pick("pmid");
    }
  };

  // ── 1. Primary match: DOI → CrossRef, Europe PMC, PubMed ──────
  // A truncated reference-list DOI ("10.1016/j.pec.2021.") is not an
  // identifier — it 404s on CrossRef and matches hundreds of papers in a
  // free-text search. Skip it and let the title search re-identify the item.
  if (doi && !isWellFormedDoi(doi)) {
    conflicts.push(`DOI incomplet/malformat în item: "${doi}"`);
  } else if (doi) {
    // 1a. CrossRef DOI lookup
    try {
      const resp = await lookupCrossRefDOI(doi);
      if (verify(resp.results[0], "CrossRef")) {
        bestPaper = resp.results[0];
        bestSource = "CrossRef";
        hasCrossrefMatch = true;
        matchedBy = "doi";
      }
    } catch { /* continue */ }

    // 1b. Also query Europe PMC by DOI (always, for supplementary data)
    if (hasCrossrefMatch && isIncomplete(bestPaper)) {
      try {
        const resp = await searchEuropePMC({ query: doi, maxResults: 3 });
        const match = bestTitleMatch(title, resp.results, 0.80);
        if (match) {
          mergeInto(bestPaper, match);
          bestSource = "CrossRef+EuropePMC";
          // If Europe PMC has a PMID we didn't have, also try PubMed
          if (match.pmid) {
            try {
              const pubMedResp = await searchPubMed({ query: match.pmid, maxResults: 3 });
              if (pubMedResp.results.length > 0) {
                mergeInto(bestPaper, pubMedResp.results[0]);
                bestSource = "CrossRef+EuropePMC+PubMed";
              }
            } catch { /* ok */ }
          }
        }
      } catch { /* continue */ }
    }

    if (bestPaper) return { paper: bestPaper, source: bestSource, matchedBy, conflicts };

    // DOI not in CrossRef — try Europe PMC as primary
    try {
      const resp = await searchEuropePMC({ query: doi, maxResults: 3 });
      if (verify(resp.results[0], "EuropePMC")) {
        return { paper: resp.results[0], source: "EuropePMC", matchedBy: "doi", conflicts };
      }
    } catch { /* continue */ }
  }

  // ── 2. PMID lookup ─────────────────────────────────────────────
  if (pmid) {
    try {
      const resp = await searchPubMed({ query: pmid, maxResults: 3 });
      if (verify(resp.results[0], "PubMed")) {
        bestPaper = resp.results[0];
        bestSource = "PubMed";
        matchedBy = "pmid";

        // Supplement with Europe PMC
        try {
          const epmcResp = await searchEuropePMC({ query: pmid, maxResults: 3 });
          if (epmcResp.results.length > 0) {
            mergeInto(bestPaper, epmcResp.results[0]);
            bestSource = "PubMed+EuropePMC";
          }
        } catch { /* ok */ }

        return { paper: bestPaper, source: bestSource, matchedBy, conflicts };
      }
    } catch { /* continue */ }

    try {
      const resp = await searchEuropePMC({ query: pmid, maxResults: 3 });
      if (verify(resp.results[0], "EuropePMC")) {
        return { paper: resp.results[0], source: "EuropePMC", matchedBy: "pmid", conflicts };
      }
    } catch { /* continue */ }
  }

  // ── 3. ISBN lookup (books) ─────────────────────────────────────
  if (isbn && itemType === "book") {
    try {
      const resp = await searchOpenLibrary({ query: isbn, maxResults: 3 });
      if (verify(resp.results[0], "OpenLibrary")) {
        return { paper: resp.results[0], source: "OpenLibrary", matchedBy: "isbn", conflicts };
      }
    } catch { /* continue */ }

    try {
      const resp = await searchGoogleBooks({ query: isbn, maxResults: 3 });
      if (verify(resp.results[0], "GoogleBooks")) {
        return { paper: resp.results[0], source: "GoogleBooks", matchedBy: "isbn", conflicts };
      }
    } catch { /* continue */ }
  }

  // ── 4. Title search (all sources) ──────────────────────────────
  // Also the recovery path: reached whenever the identifiers above were
  // absent, malformed, or pointed at a different article.
  if (cleanQuery.length < 15) {
    return conflicts.length > 0 ? { paper: null, source: "", matchedBy, conflicts } : null;
  }
  matchedBy = "title";

  // 4a. CrossRef
  try {
    const resp = await searchCrossRef({ query: cleanQuery, maxResults: 5 });
    bestPaper = bestTitleMatch(title, resp.results, 0.85);
    if (bestPaper) { bestSource = "CrossRef"; hasCrossrefMatch = true; }
  } catch { /* continue */ }

  // 4b. Europe PMC (primary or supplement)
  try {
    const resp = await searchEuropePMC({ query: cleanQuery, maxResults: 5 });
    const epmcMatch = bestTitleMatch(title, resp.results, 0.85);
    if (epmcMatch) {
      if (!bestPaper) {
        bestPaper = epmcMatch;
        bestSource = "EuropePMC";
        // Try to supplement with PubMed
        if (epmcMatch.pmid) {
          try {
            const pubResp = await searchPubMed({ query: epmcMatch.pmid, maxResults: 3 });
            if (pubResp.results.length > 0) {
              mergeInto(bestPaper, pubResp.results[0]);
              bestSource = "EuropePMC+PubMed";
            }
          } catch { /* ok */ }
        }
      } else {
        mergeInto(bestPaper, epmcMatch);
        bestSource += "+EuropePMC";
      }
    }
  } catch { /* continue */ }

  // 4c. DOAJ (supplementary)
  if (itemType === "journalArticle") {
    try {
      const resp = await searchDOAJ({ query: cleanQuery, maxResults: 5 });
      const match = bestTitleMatch(title, resp.results, 0.85);
      if (match) {
        if (!bestPaper) { bestPaper = match; bestSource = "DOAJ"; }
        else { mergeInto(bestPaper, match); bestSource += "+DOAJ"; }
      }
    } catch { /* continue */ }
  }

  // 4d. Books: Open Library + Google Books
  if (itemType === "book") {
    try {
      const resp = await searchOpenLibrary({ query: cleanQuery, maxResults: 5 });
      const match = bestTitleMatch(title, resp.results, 0.85);
      if (match) {
        if (!bestPaper) { bestPaper = match; bestSource = "OpenLibrary"; }
        else { mergeInto(bestPaper, match); bestSource += "+OpenLibrary"; }
      }
    } catch { /* continue */ }

    try {
      const resp = await searchGoogleBooks({ query: cleanQuery, maxResults: 5 });
      const match = bestTitleMatch(title, resp.results, 0.85);
      if (match) {
        if (!bestPaper) { bestPaper = match; bestSource = "GoogleBooks"; }
        else { mergeInto(bestPaper, match); bestSource += "+GoogleBooks"; }
      }
    } catch { /* continue */ }
  }

  if (bestPaper) return { paper: bestPaper, source: bestSource, matchedBy, conflicts };
  return conflicts.length > 0 ? { paper: null, source: "", matchedBy, conflicts } : null;
}

/** Normalize a DOI: strip URL prefixes, trim whitespace */
function normalizeDOI(raw: string | undefined): string {
  if (!raw) return "";
  let doi = raw.trim();
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  doi = doi.replace(/^https?:\/\/doi\.org\//i, "");
  return doi;
}

/** Best match by title similarity */
function bestTitleMatch(targetTitle: string | undefined, candidates: any[], minScore: number): any | null {
  if (!targetTitle) return null;
  let bestScore = minScore;
  let best = null;
  for (const p of candidates) {
    if (!p.title) continue;
    const score = titleSimilarity(targetTitle, p.title);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * Scan all journal articles AND books, verify against CrossRef, and auto-correct.
 *
 * - Items with DOI → DOI lookup
 * - Items without DOI → title search + similarity match
 * - "Fill" mode: only adds missing fields, never overwrites
 * - "Verify" mode: checks ALL fields, corrects discrepancies automatically
 */
export async function batchAutoUpdateLibrary(options?: {
  verify?: boolean;
  dryRun?: boolean;
  maxItems?: number;
  startFrom?: number;         // resume from checkpoint
  sortMode?: string;          // "modified-desc" | "modified-asc" | "title-asc"
  cancelToken?: { cancelled: boolean };
  onProgress?: (current: number, total: number, title: string, source: string) => void;
}): Promise<BatchUpdateResult[]> {
  const verify = options?.verify ?? true;
  const dryRun = options?.dryRun ?? false;
  const maxItems = options?.maxItems ?? Infinity;
  const startFrom = options?.startFrom ?? 0;
  const sortMode = options?.sortMode ?? "modified-desc";
  const cancelToken = options?.cancelToken;
  const onProgress = options?.onProgress;

  const libraryID = Zotero.Libraries.userLibraryID;

  // Collect ALL journal articles + books (with DOI or meaningful title)
  // But ONLY those missing data — skip already-complete items for speed
  const allItems: Array<{ item: any; itemType: string; missingFields: string[] }> = [];

  for (const type of ["journalArticle", "book"]) {
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("itemType", "is", type);
    s.addCondition("noChildren", "true" as any);
    const ids = await s.search();

    for (const id of ids) {
      const item = Zotero.Items.get(id);
      if (!item || item.isNote() || item.isAttachment()) continue;

      const doi = normalizeDOI((item.getField("DOI") as string));
      const pmid = (item.getField("extra") as string)?.match(/PMID:\s*(\d+)/)?.[1] || "";
      const isbn = (item.getField("ISBN") as string)?.trim();
      const title = (item.getField("title") as string)?.trim();

      // Verifiable if: DOI, PMID, ISBN, or meaningful title
      if (!doi && !pmid && !isbn && (!title || title.length <= 15)) continue;

      // In verify mode, check ALL items. In fill mode, only check items missing data.
      const missingFields: string[] = [];
      if (type === "journalArticle") {
        if (!verify) {
          if (!(item.getField("volume") as string)?.trim()) missingFields.push("volume");
          if (!(item.getField("issue") as string)?.trim()) missingFields.push("issue");
          if (!(item.getField("pages") as string)?.trim()) missingFields.push("pages");
        }
      } else {
        if (!verify) {
          if (!(item.getField("publisher") as string)?.trim()) missingFields.push("publisher");
          if (!(item.getField("place") as string)?.trim()) missingFields.push("place");
          if (!(item.getField("ISBN") as string)?.trim()) missingFields.push("ISBN");
        }
      }

      // In fill mode, skip if nothing missing
      if (!verify && missingFields.length === 0) continue;

      allItems.push({ item, itemType: type, missingFields });
    }
  }

  // Sort items according to preference
  if (sortMode === "modified-desc") {
    allItems.sort((a, b) => ((b.item as any).dateModified || "").localeCompare((a.item as any).dateModified || ""));
  } else if (sortMode === "modified-asc") {
    allItems.sort((a, b) => ((a.item as any).dateModified || "").localeCompare((b.item as any).dateModified || ""));
  } else if (sortMode === "title-asc") {
    allItems.sort((a, b) => {
      const ta = (a.item.getField("title") as string || "").toLowerCase();
      const tb = (b.item.getField("title") as string || "").toLowerCase();
      return ta.localeCompare(tb);
    });
  }

  Zotero.log(`[InstantCite] BatchAutoUpdate: ${allItems.length} items to process (verify=${verify}, sort=${sortMode})`);

  const total = Math.min(allItems.length, maxItems);
  const results: BatchUpdateResult[] = [];
  const sourceStats: Record<string, number> = {};
  let noMatch = 0;

  const CHECKPOINT_INTERVAL = 100;

  for (let i = startFrom; i < Math.min(allItems.length, startFrom + maxItems); i++) {
    // Check cancellation
    if (cancelToken?.cancelled) {
      Zotero.log(`[InstantCite] BatchAutoUpdate: cancelled at ${i}/${allItems.length}`);
      // Save checkpoint
      try { Zotero.Prefs.set("InstantCite.autoUpdateCheckpoint", i); } catch { /* ok */ }
      break;
    }

    const { item, itemType } = allItems[i];
    const itemTitle = (item.getField("title") as string) || "Untitled";
    const doi = normalizeDOI((item.getField("DOI") as string)) || "";

    if (onProgress) onProgress(i + 1, allItems.length, itemTitle, "");

    try {
      const match = await findMatch(item, itemType);
      if (!match || !match.paper) {
        // No usable record. When identifiers resolved to a different article,
        // report it — that item's DOI needs a human decision.
        noMatch++;
        results.push({
          itemId: item.id, title: itemTitle, doi, added: [], changed: [], itemType,
          conflicts: match?.conflicts?.length ? match.conflicts : undefined,
        });
        if (onProgress) {
          onProgress(i + 1, allItems.length, itemTitle, match?.conflicts?.length ? "DOI mismatch" : "no match");
        }
        continue;
      }

      sourceStats[match.source] = (sourceStats[match.source] || 0) + 1;
      if (onProgress) onProgress(i + 1, allItems.length, itemTitle, match.source);

      const paper = match.paper;
      const added: string[] = [];
      const changed: string[] = [];

      const fieldMap: Record<string, string> = itemType === "book"
        ? { publisher: "publisher", place: "place", isbn: "ISBN" }
        : { volume: "volume", issue: "issue", pages: "pages", issn: "ISSN", journalAbbreviation: "journalAbbreviation" };

      for (const [paperField, zField] of Object.entries(fieldMap)) {
        const paperVal = ((paper as any)[paperField] ?? "").toString().trim();
        if (!paperVal) continue;

        let itemVal = "";
        try { itemVal = ((item.getField(zField) as string) ?? "").trim(); } catch { /* field may not exist */ }

        if (!itemVal && paperVal) {
          added.push(`${zField}: ${paperVal}`);
          if (!dryRun) { try { item.setField(zField, paperVal); } catch { /* skip */ } }
        } else if (verify && itemVal && paperVal && itemVal.toLowerCase() !== paperVal.toLowerCase()) {
          changed.push(`${zField}: "${itemVal}" → "${paperVal}"`);
          if (!dryRun) { try { item.setField(zField, paperVal); } catch { /* skip */ } }
        }
      }

      // Year check
      if (verify && paper.year > 0) {
        const dateStr = (item.getField("date") as string)?.trim() || "";
        const itemYearMatch = dateStr.match(/(\d{4})/);
        const itemYear = itemYearMatch ? parseInt(itemYearMatch[1], 10) : 0;
        if (itemYear > 0 && itemYear !== paper.year) {
          changed.push(`year: ${itemYear} → ${paper.year}`);
          if (!dryRun) { try { item.setField("date", dateStr.replace(/\d{4}/, String(paper.year))); } catch { /* skip */ } }
        } else if (itemYear === 0 && paper.year > 0) {
          added.push(`year: ${paper.year}`);
          if (!dryRun) { try { item.setField("date", String(paper.year)); } catch { /* skip */ } }
        }
      }

      // Journal name for articles
      if (verify && itemType === "journalArticle" && paper.journal) {
        const itemJournal = ((item.getField("publicationTitle") as string) ?? "").trim();
        const paperJournal = paper.journal.trim();
        if (itemJournal && paperJournal && itemJournal.toLowerCase() !== paperJournal.toLowerCase()
            && itemJournal.length > 2 && paperJournal.length > 2) {
          changed.push(`journal: "${itemJournal}" → "${paperJournal}"`);
          if (!dryRun) { try { item.setField("publicationTitle", paperJournal); } catch { /* skip */ } }
        } else if (!itemJournal && paperJournal) {
          added.push(`journal: ${paperJournal}`);
          if (!dryRun) { try { item.setField("publicationTitle", paperJournal); } catch { /* skip */ } }
        }
      }

      // DOI: fill when missing, and correct one that belonged to another
      // article. Only a title match licenses a rewrite — a record found *by*
      // the DOI can never disagree with it.
      if (paper.doi) {
        if (!doi) {
          added.push(`DOI: ${paper.doi}`);
          if (!dryRun) { try { item.setField("DOI", paper.doi); } catch { /* skip */ } }
        } else if (verify && match.matchedBy === "title" && !sameDoi(doi, paper.doi)) {
          changed.push(`DOI: "${doi}" → "${paper.doi}" (old DOI pointed to another article)`);
          if (!dryRun) { try { item.setField("DOI", paper.doi); } catch { /* skip */ } }
        }
      }

      if (!dryRun && (added.length > 0 || changed.length > 0)) {
        await item.saveTx();
      }

      results.push({
        itemId: item.id, title: itemTitle, doi: doi || (paper as any).doi || "",
        added, changed, itemType,
        conflicts: match.conflicts.length > 0 ? match.conflicts : undefined,
      });
    } catch (e: any) {
      results.push({
        itemId: item.id, title: itemTitle, doi, added: [], changed: [], itemType: "",
        error: String(e?.message ?? e),
      });
    }

    // Save checkpoint every 100 items
    if ((i - startFrom) > 0 && (i - startFrom) % CHECKPOINT_INTERVAL === 0) {
      try { Zotero.Prefs.set("InstantCite.autoUpdateCheckpoint", i); } catch { /* ok */ }
    }

    // Rate limit with shorter delay for multi-source efficiency
    if (i < allItems.length - 1) {
      await new Promise(r => setTimeout(r, 150));
    }

    // Yield to event loop every 20 items (keeps UI responsive)
    if ((i - startFrom) % 20 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Clear checkpoint on completion
  try { Zotero.Prefs.clear("InstantCite.autoUpdateCheckpoint"); } catch { /* ok */ }

  const filled = results.filter(r => r.added.length > 0).length;
  const corrected = results.filter(r => r.changed.length > 0).length;
  const errors = results.filter(r => r.error).length;
  const sourceBreakdown = Object.entries(sourceStats).map(([s, c]) => `${s}: ${c}`).join(", ");
  Zotero.log(`[InstantCite] BatchAutoUpdate done — sources: ${sourceBreakdown}, no match: ${noMatch}`);
  Zotero.log(`[InstantCite] Results: ${filled} filled, ${corrected} corrected, ${errors} errors`);

  return results;
}

/**
 * Fast local-only scan — counts ALL verifiable items (articles + books)
 * that have a DOI or a meaningful title. Returns counts and sample titles.
 */
async function quickCount(): Promise<{ articles: number; books: number; examples: string[] }> {
  const libraryID = Zotero.Libraries.userLibraryID;
  let articles = 0;
  let books = 0;
  const examples: string[] = [];

  for (const type of ["journalArticle", "book"]) {
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("itemType", "is", type);
    s.addCondition("noChildren", "true" as any);
    const ids = await s.search();

    for (const id of ids) {
      const item = Zotero.Items.get(id);
      if (!item || item.isNote() || item.isAttachment()) continue;

      const doi = normalizeDOI((item.getField("DOI") as string));
      const pmid = (item.getField("extra") as string)?.match(/PMID:\s*(\d+)/)?.[1] || "";
      const isbn = (item.getField("ISBN") as string)?.trim();
      const title = (item.getField("title") as string)?.trim();

      // Count if verifiable: DOI, PMID, ISBN, or meaningful title
      if (doi || pmid || isbn || (title && title.length > 15)) {
        if (type === "journalArticle") articles++;
        else books++;

        if (examples.length < 5) {
          const displayTitle = title || "Untitled";
          const tag = doi ? "[DOI]" : "[title]";
          examples.push(`${tag} [${type === "book" ? "Book" : "Article"}] ${displayTitle}`);
        }
      }

      if ((articles + books) % 200 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  return { articles, books, examples: [] };
}

/**
 * Show progress/results UI for batch library auto-update.
 */
/**
 * Show progress/results UI for batch library auto-update.
 * Always runs in verify+fix mode. Processes in chunks of 500.
 * Minimal logging — only shows summary every 100 items.
 */
export async function runBatchAutoUpdateWithUI(): Promise<void> {
  const mainWin = Zotero.getMainWindow();
  if (!mainWin) return;

  // Check checkpoint
  let checkpoint = 0;
  try { checkpoint = Zotero.Prefs.get("InstantCite.autoUpdateCheckpoint") as number || 0; } catch { /* */ }

  // Fast local scan first
  const { articles, books } = await quickCount();
  const total = articles + books;
  if (total === 0) {
    Services.prompt.alert(mainWin, "AutoUpdate Library", "No verifiable items found (need DOI or meaningful title).");
    return;
  }

  // Confirm start
  const sortMode = getAutoUpdateSortOrder();
  const sortLabel = sortMode === "modified-desc" ? "most recent first" :
    sortMode === "modified-asc" ? "oldest first" : "by title (A-Z)";

  const breakdown = [articles > 0 ? `${articles} articles` : "", books > 0 ? `${books} books` : ""].filter(Boolean).join(", ");
  const estMin = Math.max(1, Math.round(total * 0.2 / 60));
  let msg = `${total} items (${breakdown}) will be verified against CrossRef, Europe PMC, PubMed + others.\n`;
  msg += `Volume, issue, pages, publisher, place, ISBN — all checked and auto-corrected.\n`;
  msg += `Order: ${sortLabel} (change in Tools → Instant Cite settings).\n`;
  msg += `Estimated time: ~${estMin} minutes.`;
  if (checkpoint > 0) msg += `\n\nResuming from checkpoint #${checkpoint}.`;

  if (!Services.prompt.confirm(mainWin, "AutoUpdate Library", msg)) return;

  // Open progress window
  const win = mainWin.openDialog(
    "chrome://instantcite/content/autoupdate.xhtml",
    "instantcite-autoupdate",
    "chrome,centerscreen,resizable=yes,width=650,height=620",
  );

  const cancelToken = { cancelled: false };
  let cursor = checkpoint > 0 ? checkpoint : 0;
  let totalFilled = 0;
  let totalCorrected = 0;
  let totalNoMatch = 0;
  let totalErrors = 0;

  // Helper: safe DOM update
  const $ = (id: string) => { try { return win?.document?.getElementById(id); } catch { return null; } };
  const updateUI = () => {
    const pct = total > 0 ? Math.min(100, Math.round(cursor / total * 100)) : 0;
    const bar = $("progress-bar"); if (bar) (bar as any).style.width = pct + "%";
    const pt = $("progress-text"); if (pt) pt.textContent = `${cursor} / ${total} (${pct}%)`;
    const fe = $("filled-count"); if (fe) fe.textContent = String(totalFilled);
    const ce = $("corrected-count"); if (ce) ce.textContent = String(totalCorrected);
    const ne = $("nomatch-count"); if (ne) ne.textContent = String(totalNoMatch);
    const ee = $("errors-count"); if (ee) ee.textContent = String(totalErrors);
  };

  // Wire cancel button + Escape after window loads
  win.addEventListener("load", () => {
    const btn = $("btn-cancel");
    if (btn) btn.addEventListener("click", () => { cancelToken.cancelled = true; });
    win.addEventListener("keydown", (e: any) => { if (e.key === "Escape") cancelToken.cancelled = true; });
  }, { once: true });

  // Also listen on main window
  const onKey = (e: any) => { if (e.key === "Escape") cancelToken.cancelled = true; };
  mainWin.addEventListener("keydown", onKey);

  try {
    while (!cancelToken.cancelled) {
      const chunkStart = Date.now();
      const results = await batchAutoUpdateLibrary({
        verify: true, dryRun: false,
        maxItems: 500, startFrom: cursor, sortMode, cancelToken,
        onProgress: (current, _t, title) => {
          // Update every 5 items for smooth progress
          if (current % 5 === 0) {
            const globalCursor = cursor + current;
            const pct = total > 0 ? Math.min(100, Math.round(globalCursor / total * 100)) : 0;
            try {
              const bar = $("progress-bar"); if (bar) (bar as any).style.width = pct + "%";
              const pt = $("progress-text"); if (pt) pt.textContent = `${globalCursor} / ${total} (${pct}%)`;
              const cur = $("current-item"); if (cur) cur.textContent = title.slice(0, 150);
            } catch { /* */ }
          }
        },
      });

      cursor += results.length;
      const elapsed = Math.round((Date.now() - chunkStart) / 1000);

      for (const r of results) {
        if (r.error) { totalErrors++; continue; }
        if (r.added.length > 0) totalFilled += r.added.length;
        if (r.changed.length > 0) totalCorrected += r.changed.length;
        if (r.added.length === 0 && r.changed.length === 0 && !r.error) totalNoMatch++;
        // Surface DOI/identifier mismatches — these need a human decision and
        // would otherwise be invisible among the "no match" items.
        if (r.conflicts?.length) {
          const line = `⚠ DOI mismatch — "${r.title.slice(0, 60)}" (${r.doi || "no DOI"}): ${r.conflicts.join(" | ")}\n`;
          try { const logEl = $("log-area"); if (logEl) logEl.textContent += line; } catch { /* */ }
          Zotero.log("[InstantCite] " + line.trim());
        }
      }

      updateUI();

      // Chunk summary in log
      const fixedInChunk = results.filter(r => r.added.length > 0 || r.changed.length > 0).length;
      try {
        const logEl = $("log-area");
        if (logEl) logEl.textContent += `[${elapsed}s] ${fixedInChunk} fixed, total: ${totalFilled} new + ${totalCorrected} corrected | cursor=${cursor}\n`;
      } catch { /* */ }

      Zotero.log(`[InstantCite] ${elapsed}s — filled=${totalFilled} corrected=${totalCorrected} cursor=${cursor}`);

      if (cancelToken.cancelled) break;
      if (results.length < 500) break;
    }

    updateUI();
    try {
      const bar = $("progress-bar"); if (bar) (bar as any).style.width = "100%";
      const pt = $("progress-text"); if (pt) pt.textContent = cancelToken.cancelled ? "Cancelled" : "Complete!";
      const btn = $("btn-cancel"); if (btn) {
        btn.textContent = "Close";
        btn.className = "btn-close";
        btn.addEventListener("click", () => { try { win.close(); } catch { /* */ } });
      }
    } catch { /* */ }

    if (cancelToken.cancelled) {
      try { Zotero.Prefs.set("InstantCite.autoUpdateCheckpoint", cursor); } catch { /* */ }
    } else {
      try { Zotero.Prefs.clear("InstantCite.autoUpdateCheckpoint"); } catch { /* */ }
    }

  } finally {
    mainWin.removeEventListener("keydown", onKey);
  }
}
