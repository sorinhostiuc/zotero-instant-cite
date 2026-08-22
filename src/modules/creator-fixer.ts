/**
 * Creator Fixer — batch scan and fix misidentified creators in Zotero library.
 *
 * Fixes:
 * 1. Corporate/institutional names parsed as personal names (e.g. court names)
 * 2. First name / last name inversions
 * 3. Case items with court name as personal author → fieldMode: 1
 * 4. (NEW) CrossRef verification: for items with DOI, checks author list against
 *    CrossRef data and fills in missing structured names (lastName/firstName)
 */

import { isCorporateAuthor, parseAuthorName } from "./zotero-bridge";
import { lookupCrossRefDOI } from "./api/crossref";
import { searchEuropePMC } from "./api/europepmc";
import { searchOpenLibrary } from "./api/open-library";
import { searchGoogleBooks } from "./api/google-books";
import type { PaperResult } from "./api/types";

export interface FixResult {
  itemId: number;
  title: string;
  fixes: string[];
}

/**
 * Scan all case-type items (or all items) and fix creator issues.
 * Returns list of items that were fixed.
 */
export async function fixCreatorsInLibrary(options?: {
  caseItemsOnly?: boolean;
  dryRun?: boolean;
  crossrefVerify?: boolean;
}): Promise<FixResult[]> {
  const caseOnly = options?.caseItemsOnly ?? false;
  const dryRun = options?.dryRun ?? false;
  const crossrefVerify = options?.crossrefVerify ?? false;
  const results: FixResult[] = [];

  const libraryID = Zotero.Libraries.userLibraryID;
  const s = new Zotero.Search();
  s.libraryID = libraryID;

  if (caseOnly) {
    s.addCondition("itemType", "is", "case");
  } else {
    s.addCondition("noChildren", "true" as any);
  }

  const ids = await s.search();
  Zotero.log(`[InstantCite] Creator fixer: scanning ${ids.length} items (caseOnly=${caseOnly}, crossref=${crossrefVerify})`);

  let i = 0;
  for (const id of ids) {
    const item = Zotero.Items.get(id);
    if (!item || item.isNote() || item.isAttachment()) continue;

    const fixes = crossrefVerify
      ? await fixItemCreatorsWithCrossRef(item)
      : fixItemCreators(item);

    if (fixes.length > 0) {
      if (!dryRun) {
        await item.saveTx();
      }
      results.push({
        itemId: id,
        title: (item.getField("title") as string) || "Untitled",
        fixes,
      });
    }

    // Yield every 20 items
    i++;
    if (i % 20 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  Zotero.log(`[InstantCite] Creator fixer: fixed ${results.length} items`);
  return results;
}

/**
 * Fix creators on a single Zotero item. Returns list of changes made.
 * Mutates the item but does NOT save (caller should saveTx).
 */
export function fixItemCreators(item: any): string[] {
  const creators = item.getCreators();
  if (!creators || creators.length === 0) return [];

  const itemType = item.itemType as string;
  const isCase = itemType === "case";
  const courtField = isCase ? safeGetField(item, "court") : "";
  const fixes: string[] = [];

  for (let i = 0; i < creators.length; i++) {
    const c = creators[i];
    // Skip already corporate
    if (c.fieldMode === 1) continue;

    const fullName = c.firstName
      ? `${c.firstName} ${c.lastName}`.trim()
      : c.lastName || "";

    if (!fullName) continue;

    // Fix 1: Name that matches the court field → should be corporate or removed
    if (isCase && courtField && isCourtMatch(fullName, courtField)) {
      item.setCreator(i, {
        lastName: courtField,
        creatorType: c.creatorType || "author",
        fieldMode: 1,
      } as any);
      fixes.push(`Court as personal → corporate: "${fullName}"`);
      continue;
    }

    // Fix 2: Corporate name parsed as personal
    if (isCorporateAuthor(fullName)) {
      item.setCreator(i, {
        lastName: fullName,
        creatorType: c.creatorType || "author",
        fieldMode: 1,
      } as any);
      fixes.push(`Corporate detected: "${fullName}" → fieldMode:1`);
      continue;
    }

    // Fix 3: Name/surname inversion heuristic
    // If firstName looks like a surname and lastName looks like a first name
    if (c.firstName && c.lastName) {
      const swapped = detectInversion(c.firstName, c.lastName);
      if (swapped) {
        item.setCreator(i, {
          firstName: c.lastName,
          lastName: c.firstName,
          creatorType: c.creatorType || "author",
        });
        fixes.push(`Swapped: "${c.firstName} ${c.lastName}" → "${c.lastName} ${c.firstName}"`);
      }
    }
  }

  return fixes;
}

/**
 * Enhanced fix that also verifies creators against CrossRef when the item has a DOI.
 * - Fills in missing structured author names (lastName/firstName from CrossRef)
 * - Detects authors missing entirely from Zotero
 * - Validates corporate detection against CrossRef data
 */
export async function fixItemCreatorsWithCrossRef(item: any): Promise<string[]> {
  // IMPORTANT: fixItemCreators mutates the item, so get creators AFTER heuristic fixes
  const fixes = fixItemCreators(item);

  // Then try CrossRef verification
  const doi = ((item.getField("DOI") as string) ?? "").trim();
  if (!doi) return fixes;

  try {
    const resp = await lookupCrossRefDOI(doi);
    if (resp.results.length === 0) return fixes;
    const crossrefPaper = resp.results[0];
    const crossrefAuthors = crossrefPaper.authors ?? [];

    if (crossrefAuthors.length === 0) return fixes;

    // Re-read creators AFTER heuristic fixes (critical: avoids stale indexOf references)
    const zoteroCreators = item.getCreators() || [];

    // Build name set from post-fix creators
    const zoteroNames = new Set<string>();
    for (const c of zoteroCreators) {
      const full = [c.firstName || "", c.lastName || ""].join(" ").trim().toLowerCase();
      if (full) zoteroNames.add(full);
      if (c.lastName) zoteroNames.add(c.lastName.toLowerCase());
    }

    // Check each CrossRef author against Zotero (only ADD missing, never remove)
    for (const xa of crossrefAuthors) {
      const xaFull = [xa.firstName || "", xa.lastName || ""].join(" ").trim();
      const xaFullLower = xaFull.toLowerCase();
      const xaName = xa.name?.toLowerCase() || "";

      // Skip if already exists
      if ((xaFullLower && zoteroNames.has(xaFullLower)) || (xaName && zoteroNames.has(xaName))) {
        continue;
      }

      // Fuzzy match against current (post-fix) creators
      let found = false;
      const currentCreators = item.getCreators(); // always read fresh
      for (let idx = 0; idx < currentCreators.length; idx++) {
        const zc = currentCreators[idx];
        if (zc.fieldMode === 1) continue; // skip corporate, can't structure those
        const zcFull = [zc.firstName || "", zc.lastName || ""].join(" ").trim().toLowerCase();
        if (zcFull && xaFullLower && (zcFull.includes(xaFullLower) || xaFullLower.includes(zcFull))) {
          // Update structured name if CrossRef has better data
          if (xa.lastName && xa.lastName !== zc.lastName) {
            item.setCreator(idx, {
              firstName: xa.firstName || zc.firstName || "",
              lastName: xa.lastName,
              creatorType: zc.creatorType || "author",
            });
            fixes.push(`Structured name from CrossRef: "${zcFull}" → "${xa.lastName}, ${xa.firstName || ""}"`);
          }
          found = true;
          break;
        }
      }

      // Author from CrossRef not found in Zotero — ADD (never remove)
      if (!found && crossrefAuthors.length > currentCreators.length) {
        const newIdx = item.getCreators().length;
        if (xa.isCorporate) {
          item.setCreator(newIdx, {
            lastName: xa.name || xa.lastName || "",
            creatorType: "author",
            fieldMode: 1,
          } as any);
          fixes.push(`+ Missing corporate author from CrossRef: "${xa.name || xa.lastName}"`);
        } else if (xa.lastName) {
          item.setCreator(newIdx, {
            firstName: xa.firstName || "",
            lastName: xa.lastName,
            creatorType: "author",
          });
          fixes.push(`+ Missing author from CrossRef: "${xa.lastName}, ${xa.firstName || ""}"`);
        }
      }
    }
  } catch {
    // CrossRef lookup failed — heuristic fixes still apply
  }

  return fixes;
}

/**
 * Check if a creator name matches the court field (possibly split across first/last).
 * E.g. firstName="Court of Appeals of", lastName="Minnesota" for court="Court of Appeals of Minnesota"
 */
function isCourtMatch(fullName: string, court: string): boolean {
  const normFull = fullName.toLowerCase().replace(/\s+/g, " ").trim();
  const normCourt = court.toLowerCase().replace(/\s+/g, " ").trim();
  // Exact match or one contains the other
  if (normFull === normCourt) return true;
  if (normCourt.includes(normFull) && normFull.length > 5) return true;
  if (normFull.includes(normCourt) && normCourt.length > 5) return true;
  return false;
}

/**
 * Heuristic: detect if firstName and lastName are likely swapped.
 *
 * Signals that indicate inversion:
 * - firstName has multiple words (unlikely for a real first name)
 * - lastName is a single short common first name
 * - firstName is all caps (initials placed in wrong field)
 */
function detectInversion(firstName: string, lastName: string): boolean {
  const fnParts = firstName.trim().split(/\s+/);
  const lnParts = lastName.trim().split(/\s+/);

  // If firstName has multiple words and lastName is single → likely inverted
  // "Court of Appeals" (firstName) + "Minnesota" (lastName) — but this is corporate, handled above
  // "Robert" (firstName) + "Smith Johnson" (lastName) — unlikely, could be double surname

  // Initials in firstName field: "JA" as firstName, "Smith" as lastName → correct (not inverted)
  // But "Smith" as firstName, "JA" as lastName → inverted
  if (lnParts.length === 1 && /^[A-Z]{1,3}$/.test(lastName.trim())) {
    // lastName looks like initials → likely inverted (initials should be firstName)
    return true;
  }

  // firstName has 3+ words → very likely inverted or corporate
  if (fnParts.length >= 3 && lnParts.length === 1) {
    return true;
  }

  return false;
}

function safeGetField(item: any, field: string): string {
  try { return (item.getField(field) as string) || ""; } catch { return ""; }
}

/**
 * Show a progress/results dialog for the batch fixer.
 */
export async function runFixerWithUI(): Promise<void> {
  const mainWin = Zotero.getMainWindow();
  if (!mainWin) return;

  // Ask user what scope to fix
  const ps = Services.prompt;

  const flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
    ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING +
    ps.BUTTON_POS_2 * ps.BUTTON_TITLE_CANCEL;

  const choice = ps.confirmEx(
    mainWin,
    "Fix Creators",
    "Scan library for misidentified creators:\n" +
    "• Corporate names parsed as personal (e.g. 'World Health Organization' split into first/last)\n" +
    "• Name/surname inversions\n" +
    "• Missing authors (CrossRef verification)\n\n" +
    "Which items to scan?",
    flags,
    "All Items + CrossRef",
    "All Items (heuristic only)",
    "",
    null,
    {},
  );

  if (choice === 2) return;

  const crossrefVerify = choice === 0;

  // First: dry run to show preview
  const preview = await fixCreatorsInLibrary({
    caseItemsOnly: false,
    dryRun: true,
    crossrefVerify,
  });

  if (preview.length === 0) {
    ps.alert(mainWin, "Fix Creators", "No issues found. All creators look correct.");
    return;
  }

  // Show preview summary
  const summary = preview.slice(0, 15).map(r =>
    `• ${r.title.slice(0, 50)}${r.title.length > 50 ? "..." : ""}\n  ${r.fixes.join("; ")}`
  ).join("\n\n");

  const more = preview.length > 15 ? `\n\n...and ${preview.length - 15} more items.` : "";

  const confirm = ps.confirmEx(
    mainWin,
    `Fix Creators — ${preview.length} items to fix`,
    `${summary}${more}\n\nApply these fixes?`,
    ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
    ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL,
    "Apply Fixes",
    "",
    "",
    null,
    {},
  );

  if (confirm !== 0) return;

  // Apply fixes
  const results = await fixCreatorsInLibrary({
    caseItemsOnly: false,
    dryRun: false,
    crossrefVerify,
  });

  ps.alert(
    mainWin,
    "Fix Creators — Done",
    `Fixed creators in ${results.length} items.`,
  );
}

/**
 * Restore missing/damaged authors from CrossRef.
 * For items with DOIs that have 0 authors OR fewer authors than CrossRef,
 * completely replace the author list with CrossRef data.
 */
export async function restoreAuthorsFromCrossRef(options?: {
  dryRun?: boolean;
}): Promise<FixResult[]> {
  const dryRun = options?.dryRun ?? false;
  const results: FixResult[] = [];

  const libraryID = Zotero.Libraries.userLibraryID;
  const s = new Zotero.Search();
  s.libraryID = libraryID;
  s.addCondition("noChildren", "true" as any);
  const ids = await s.search();

  let totalScanned = 0, totalWithID = 0, totalMatched = 0;

  Zotero.log(`[InstantCite] Author restore: scanning ${ids.length} items`);

  for (const id of ids) {
    const item = Zotero.Items.get(id);
    if (!item || item.isNote() || item.isAttachment()) continue;
    totalScanned++;

    const doi = ((item.getField("DOI") as string) ?? "").trim();
    const isbn = ((item.getField("ISBN") as string) ?? "").trim();
    const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
    const isBook = itemType === "book";

    // Need at least DOI or ISBN to look up
    if (!doi && !isbn) continue;
    totalWithID++;

    const currentCreators = item.getCreators() || [];
    const nonEmptyCreators = currentCreators.filter((c: any) => {
      // fieldMode:1 with empty lastName = corrupted corporate author
      if (c.fieldMode === 1 && !(c.lastName || "").trim()) return false;
      const full = [c.firstName || "", c.lastName || ""].join(" ").trim();
      return full.length > 0;
    });
    const zoteroCount = nonEmptyCreators.length;

    try {
    // Try to find paper in external databases
    let paper: PaperResult | null = null;

    // 1. DOI → CrossRef
    if (doi) {
      try {
        const resp = await lookupCrossRefDOI(doi);
        if (resp.results.length > 0) paper = resp.results[0];
      } catch { /* */ }
    }

    // 2. ISBN → Open Library / Google Books (books)
    if (!paper && isbn && isBook) {
      try {
        const resp = await searchOpenLibrary({ query: isbn, maxResults: 3 });
        if (resp.results.length > 0) paper = resp.results[0];
      } catch { /* */ }

      if (!paper) {
        try {
          const resp = await searchGoogleBooks({ query: isbn, maxResults: 3 });
          if (resp.results.length > 0) paper = resp.results[0];
        } catch { /* */ }
      }
    }

    // 3. DOI → Europe PMC (fallback)
    if (!paper && doi) {
      try {
        const resp = await searchEuropePMC({ query: doi, maxResults: 3 });
        if (resp.results.length > 0) paper = resp.results[0];
      } catch { /* */ }
    }

    if (!paper) continue;
    totalMatched++;
    const srcAuthors = paper.authors ?? [];
    if (srcAuthors.length === 0) continue;

    // Don't touch if source has same or fewer authors than Zotero (unless Zotero has 0)
    if (srcAuthors.length <= zoteroCount && zoteroCount > 0) continue;

    const fixes: string[] = [];
    fixes.push(`Restoring ${srcAuthors.length} authors from ${paper?.sources?.[0] || "CrossRef"} (had ${zoteroCount})`);

    if (!dryRun) {
      // Remove all existing creators
      const numExisting = item.getCreators().length;
      for (let i = numExisting - 1; i >= 0; i--) {
        item.removeCreator(i);
      }

      // Add source authors
      for (const xa of srcAuthors) {
        if (xa.isCorporate) {
          item.setCreator(item.getCreators().length, {
            lastName: xa.name || xa.lastName || "",
            creatorType: "author",
            fieldMode: 1,
          } as any);
        } else {
          item.setCreator(item.getCreators().length, {
            firstName: xa.firstName || "",
            lastName: xa.lastName || xa.name || "",
            creatorType: "author",
          });
        }
      }

      await item.saveTx();
    }

    results.push({
      itemId: id,
      title: (item.getField("title") as string) || "Untitled",
      fixes,
    });
  } catch {
    // Skip failed lookups
  }
  }

  Zotero.log(`[InstantCite] Author restore: scanned=${totalScanned} withID=${totalWithID} matched=${totalMatched} fixed=${results.length}`);
  return results;
}

/**
 * UI for restoring damaged author lists from CrossRef.
 */
export async function runAuthorRestoreWithUI(): Promise<void> {
  const mainWin = Zotero.getMainWindow();
  if (!mainWin) return;

  const ps = Services.prompt;
  Zotero.log("[InstantCite] Restore Authors UI: opened");

  if (!ps.confirm(mainWin, "Restore Authors",
    "Scan all items with DOI/ISBN and restore missing/damaged\n" +
    "authors from CrossRef, Europe PMC, Open Library, and Google Books.\n\n" +
    "If an external database has MORE authors than your Zotero item,\n" +
    "the author list will be REPLACED with the database version.\n\n" +
    "This is automatic — no preview, just results at the end.\n\n" +
    "Start?")) return;

  // Direct apply — no preview
  Zotero.log("[InstantCite] Restore Authors: scanning and fixing...");
  const results = await restoreAuthorsFromCrossRef({ dryRun: false });
  Zotero.log(`[InstantCite] Restore Authors: done — ${results.length} items fixed`);

  if (results.length === 0) {
    ps.alert(mainWin, "Restore Authors", "No items needed author restoration.\n\nAll items already have more or equal authors compared to external databases.");
    return;
  }

  const summary = results.slice(0, 15).map(r =>
    `${r.title.slice(0, 70)}${r.title.length > 70 ? "..." : ""}\n  ${r.fixes[0]}`
  ).join("\n\n");
  const more = results.length > 15 ? `\n\n...and ${results.length - 15} more items.` : "";

  ps.alert(mainWin, `Restore Authors — ${results.length} items fixed`, summary + more);
}
