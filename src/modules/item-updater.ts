/**
 * Single-item AutoUpdate — right-click on any Zotero item to update it
 * from external databases using DOI or ISBN.
 */

import { lookupCrossRefDOI, searchCrossRef } from "./api/crossref";
import { searchEuropePMC } from "./api/europepmc";
import { searchPubMed } from "./api/pubmed";
import { searchOpenLibrary } from "./api/open-library";
import { searchGoogleBooks } from "./api/google-books";
import { isWellFormedDoi, normalizeDoi, sameDoi, titlesAgree } from "./utils/doi";
import { titleSimilarity } from "./utils/deduplicator";
import type { PaperResult } from "./api/types";

/** Similarity required before a title search is trusted to re-identify an item. */
const TITLE_MATCH_MIN = 0.85;

/** Fields updated per item type */
const JOURNAL_FIELDS: Array<{ paper: string; zotero: string }> = [
  { paper: "volume", zotero: "volume" },
  { paper: "issue", zotero: "issue" },
  { paper: "pages", zotero: "pages" },
  { paper: "issn", zotero: "ISSN" },
  { paper: "journalAbbreviation", zotero: "journalAbbreviation" },
];

const BOOK_FIELDS: Array<{ paper: string; zotero: string }> = [
  { paper: "publisher", zotero: "publisher" },
  { paper: "place", zotero: "place" },
];

function getItemTypeName(item: any): string {
  try {
    return Zotero.ItemTypes.getName(item.itemTypeID);
  } catch {
    return String(item.itemTypeID || "");
  }
}

function safeGetField(item: any, field: string): string {
  try {
    return ((item.getField(field) as string) ?? "").toString();
  } catch (err) {
    try { Zotero.log("[InstantCite] getField('" + field + "') skipped: " + err); } catch { /* ignore */ }
    return "";
  }
}

function safeSetField(item: any, field: string, value: string): boolean {
  try {
    item.setField(field, value);
    return true;
  } catch (err) {
    try { Zotero.log("[InstantCite] setField('" + field + "') skipped: " + err); } catch { /* ignore */ }
    return false;
  }
}

function isKnownItemType(itemType: string): boolean {
  try {
    return !!Zotero.ItemTypes.getID(itemType);
  } catch {
    return false;
  }
}

function changeItemType(item: any, targetType: string): boolean {
  if (!targetType || !isKnownItemType(targetType)) return false;
  try {
    item.setType(Zotero.ItemTypes.getID(targetType));
    return true;
  } catch (err) {
    try { Zotero.log("[InstantCite] setType('" + targetType + "') skipped: " + err); } catch { /* ignore */ }
    return false;
  }
}

function getFieldMapForType(itemType: string): Array<{ paper: string; zotero: string }> {
  if (itemType === "book") return BOOK_FIELDS;
  if (itemType === "journalArticle") return JOURNAL_FIELDS;
  return [];
}

/** Best candidate above `min` similarity to the item's title, or null. */
function bestTitleMatch(title: string, candidates: PaperResult[], min: number): PaperResult | null {
  let bestScore = min;
  let best: PaperResult | null = null;
  for (const p of candidates) {
    if (!p?.title) continue;
    const score = titleSimilarity(title, p.title);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

function updateFieldIfChanged(
  item: any,
  changes: string[],
  zoteroField: string,
  displayName: string,
  newValue: unknown,
) {
  const paperVal = (newValue ?? "").toString().trim();
  if (!paperVal) return;

  const itemVal = safeGetField(item, zoteroField).trim();
  if (!itemVal) {
    if (safeSetField(item, zoteroField, paperVal)) changes.push(`+ ${displayName}: ${paperVal}`);
  } else if (itemVal.toLowerCase() !== paperVal.toLowerCase()) {
    if (safeSetField(item, zoteroField, paperVal)) changes.push(`± ${displayName}: "${itemVal}" → "${paperVal}"`);
  }
}

/**
 * Update a single Zotero item from external databases.
 * Returns list of changes made (empty if nothing to update).
 */
export async function updateSingleItem(item: any): Promise<string[]> {
  const doi = normalizeDoi(safeGetField(item, "DOI"));
  const isbn = safeGetField(item, "ISBN").trim();
  const extra = safeGetField(item, "extra");
  const pmid = (extra.match(/PMID:\s*(\d+)/)?.[1] || "").trim();
  const title = safeGetField(item, "title").trim();
  const originalItemType = getItemTypeName(item);
  let itemType = originalItemType;
  const isBook = itemType === "book";

  if (!doi && !isbn && !pmid && title.length < 15) {
    return ["No DOI, ISBN, or PMID found in this item"];
  }

  // Find matching paper in external databases
  let paper: PaperResult | null = null;
  let source = "";
  /** How the accepted record was identified — only a title match may rewrite the DOI. */
  let matchedBy: "doi" | "pmid" | "isbn" | "title" = "doi";
  /** Records rejected because they describe a different article than this item. */
  const conflicts: string[] = [];

  /**
   * Accept a candidate only if its title agrees with the item's. A record
   * fetched by identifier is authoritative about *its own* article — never
   * about this item, unless the two are the same work.
   */
  const accept = (
    candidate: PaperResult | undefined,
    src: string,
    via: "doi" | "pmid" | "isbn" | "title",
  ): boolean => {
    if (!candidate) return false;
    if (!titlesAgree(title, candidate.title)) {
      conflicts.push(
        `${src} → "${(candidate.title || "?").slice(0, 70)}"` +
        (candidate.doi ? ` (${candidate.doi})` : ""),
      );
      return false;
    }
    paper = candidate;
    source = src;
    matchedBy = via;
    return true;
  };

  // 1. DOI → CrossRef → Europe PMC
  if (doi && !paper) {
    if (!isWellFormedDoi(doi)) {
      // Truncated reference-list DOI ("10.1016/j.pec.2021."). Looking it up
      // returns hundreds of unrelated papers, so skip straight to the title.
      conflicts.push(`DOI incomplet/malformat în item: "${doi}"`);
    } else {
      try {
        const resp = await lookupCrossRefDOI(doi);
        accept(resp.results[0], "CrossRef", "doi");
      } catch { /* */ }
      if (!paper) {
        try {
          const resp = await searchEuropePMC({ query: doi, maxResults: 3 });
          accept(resp.results[0], "EuropePMC", "doi");
        } catch { /* */ }
      }
    }
  }

  // 2. PMID → PubMed → Europe PMC
  if (pmid && !paper) {
    try {
      const resp = await searchPubMed({ query: pmid, maxResults: 3 });
      accept(resp.results[0], "PubMed", "pmid");
    } catch { /* */ }
    if (!paper) {
      try {
        const resp = await searchEuropePMC({ query: pmid, maxResults: 3 });
        accept(resp.results[0], "EuropePMC", "pmid");
      } catch { /* */ }
    }
  }

  // 3. ISBN → Open Library → Google Books (books only)
  if (isbn && isBook && !paper) {
    try {
      const resp = await searchOpenLibrary({ query: isbn, maxResults: 3 });
      accept(resp.results[0], "OpenLibrary", "isbn");
    } catch { /* */ }
    if (!paper) {
      try {
        const resp = await searchGoogleBooks({ query: isbn, maxResults: 3 });
        accept(resp.results[0], "GoogleBooks", "isbn");
      } catch { /* */ }
    }
  }

  // 4. Title search — the recovery path when the identifiers are wrong,
  //    malformed or absent. A hit here is what lets us fix a bad DOI.
  if (!paper && title.length >= 15) {
    const cleanQuery = title.slice(0, 100).replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    try {
      const resp = await searchCrossRef({ query: cleanQuery, maxResults: 5 });
      const best = bestTitleMatch(title, resp.results, TITLE_MATCH_MIN);
      if (best) { paper = best; source = "CrossRef (title)"; matchedBy = "title"; }
    } catch { /* */ }
    if (!paper) {
      try {
        const resp = await searchEuropePMC({ query: cleanQuery, maxResults: 5 });
        const best = bestTitleMatch(title, resp.results, TITLE_MATCH_MIN);
        if (best) { paper = best; source = "EuropePMC (title)"; matchedBy = "title"; }
      } catch { /* */ }
    }
  }

  if (!paper) {
    const base = `Not found in external databases (DOI:${doi || "none"}, ISBN:${isbn || "none"}, PMID:${pmid || "none"})`;
    return conflicts.length > 0
      ? [`⚠ Identifier mismatch — nothing applied. ${conflicts.join(" | ")}`, base]
      : [base];
  }

  const changes: string[] = [];
  const warnings: string[] = conflicts.length > 0
    ? [`⚠ ignored mismatched identifier(s): ${conflicts.join(" | ")}`]
    : [];

  const detectedItemType = (paper.itemType || "").trim();
  if (detectedItemType && detectedItemType !== itemType && changeItemType(item, detectedItemType)) {
    itemType = getItemTypeName(item) || detectedItemType;
    changes.push(`± itemType: ${originalItemType} → ${itemType}`);
  }

  const fieldMap = getFieldMapForType(itemType);

  // Update journal/book fields
  for (const { paper: pField, zotero: zField } of fieldMap) {
    updateFieldIfChanged(item, changes, zField, zField, (paper as any)[pField]);
  }

  // Update year
  if (paper.year > 0) {
    const dateStr = safeGetField(item, "date").trim();
    const itemYearMatch = dateStr.match(/(\d{4})/);
    const itemYear = itemYearMatch ? parseInt(itemYearMatch[1], 10) : 0;
    if (itemYear === 0 && paper.year > 0) {
      if (safeSetField(item, "date", String(paper.year))) changes.push(`+ year: ${paper.year}`);
    } else if (itemYear > 0 && itemYear !== paper.year) {
      if (safeSetField(item, "date", dateStr.replace(/\d{4}/, String(paper.year)))) {
        changes.push(`± year: ${itemYear} → ${paper.year}`);
      }
    }
  }

  // Update journal name
  if (itemType === "journalArticle" && paper.journal) {
    updateFieldIfChanged(item, changes, "publicationTitle", "journal", paper.journal);
  }

  // DOI: fill when missing, and correct when the item carried one that belongs
  // to a different article. Only a title match licenses a rewrite — a record
  // found *by* the DOI can never disagree with it.
  const paperDoi = normalizeDoi(paper.doi);
  if (paperDoi) {
    if (!doi) {
      if (safeSetField(item, "DOI", paperDoi)) changes.push(`+ DOI: ${paperDoi}`);
    } else if (matchedBy === "title" && !sameDoi(doi, paperDoi)) {
      if (safeSetField(item, "DOI", paperDoi)) {
        changes.push(`± DOI: "${doi}" → "${paperDoi}" (old DOI pointed to another article)`);
      }
    }
  }

  // Fill ISBN if missing after a type change to book
  if (itemType === "book" && !isbn && paper.isbn) {
    if (safeSetField(item, "ISBN", paper.isbn)) changes.push(`+ ISBN: ${paper.isbn}`);
  }

  // Update authors if Zotero has fewer than paper
  const zoteroCreators = item.getCreators?.() || [];
  const paperAuthors = paper.authors || [];
  if (paperAuthors.length > zoteroCreators.length && zoteroCreators.length < paperAuthors.length) {
    const added: string[] = [];
    for (const pa of paperAuthors) {
      const paName = [pa.firstName || "", pa.lastName || ""].join(" ").trim().toLowerCase();
      const exists = zoteroCreators.some((c: any) => {
        const zcName = [c.firstName || "", c.lastName || ""].join(" ").trim().toLowerCase();
        return zcName === paName || (pa.lastName && zcName.includes(pa.lastName.toLowerCase()));
      });
      if (!exists && pa.lastName) {
        try {
          item.setCreator(item.getCreators().length, {
            firstName: pa.firstName || "",
            lastName: pa.lastName,
            creatorTypeID: Zotero.CreatorTypes?.getID ? Zotero.CreatorTypes.getID("author") : undefined,
            creatorType: "author",
          });
          added.push(`${pa.lastName}`);
        } catch (err) {
          try { Zotero.log("[InstantCite] setCreator skipped: " + err); } catch { /* ignore */ }
        }
      }
    }
    if (added.length > 0) changes.push(`+ authors: ${added.join(", ")}`);
  }

  if (changes.length > 0) {
    await item.saveTx();
    changes.unshift(`Updated from ${source}`);
    return [...changes, ...warnings];
  }
  if (warnings.length > 0) {
    return [`⚠ Identifier mismatch — no fields applied`, ...warnings];
  }
  return [`Already up to date (checked ${source})`];
}

/**
 * Handle right-click on Zotero items: update selected items from external databases.
 */
export async function updateSelectedItems(): Promise<void> {
  const mainWin = Zotero.getMainWindow();
  if (!mainWin) return;

  const ps = Services.prompt;

  // Get selected items from Zotero's item tree
  const items = Zotero.getActiveZoteroPane()?.getSelectedItems?.() || [];
  if (items.length === 0) {
    ps.alert(mainWin, "AutoUpdate Item", "No items selected. Right-click on an item in your library first.");
    return;
  }

  const changes: string[] = [];
  const unchanged: string[] = [];

  for (const item of items) {
    if (!item || item.isNote() || item.isAttachment()) continue;
    const title = (item.getField("title") as string) || "Untitled";

    try {
      const result = await updateSingleItem(item);
      if (result.length === 0 || result[0]?.startsWith("Already up to date")) {
        unchanged.push(title.slice(0, 60));
      } else if (result[0]?.startsWith("No DOI")) {
        unchanged.push(`${title.slice(0, 50)} — ${result[0]}`);
      } else if (result[0]?.startsWith("Not found")) {
        unchanged.push(`${title.slice(0, 50)} — ${result[0]}`);
      } else if (result[0]?.startsWith("⚠")) {
        unchanged.push(`${title.slice(0, 50)} — ${result.join(" ")}`);
      } else {
        changes.push(`${title.slice(0, 50)}: ${result.slice(1).join("; ")}`);
      }
    } catch (e: any) {
      unchanged.push(`${title.slice(0, 50)} — Error: ${e?.message || e}`);
    }
  }

  let msg = "";
  if (changes.length > 0) {
    msg += `Updated ${changes.length} item(s):\n`;
    msg += changes.map(c => `  ${c}`).join("\n") + "\n\n";
  }
  if (unchanged.length > 0) {
    msg += `${unchanged.length} item(s) skipped or unchanged.`;
  }
  if (changes.length === 0 && unchanged.length === 0) {
    msg = "No items to process.";
  }

  ps.alert(mainWin, "AutoUpdate Item", msg);
}
