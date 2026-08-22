import type { PaperResult } from "./api/types";
import { isAutoDownloadPDF } from "./preferences";

/**
 * Add paper to Zotero library.
 * @param skipPDF - skip PDF download (used during batch cite for speed)
 */
export async function addToZotero(paper: PaperResult, skipPDF = false): Promise<Zotero.Item> {
  // Fast path: if we already know the Zotero item ID from a previous call, use it directly.
  // This prevents duplicates when the user edits a paper (changing title/identifiers)
  // and then triggers addToZotero again — findExisting would fail on changed identifiers.
  if ((paper as any)._zoteroItemId) {
    const knownItem = Zotero.Items.get((paper as any)._zoteroItemId);
    if (knownItem) {
      if (knownItem.getCreators().length === 0 && paper.authors.length > 0) {
        try { await addAuthorsToItem(knownItem, paper); } catch { /* ignore */ }
      }
      if (!skipPDF && isAutoDownloadPDF()) {
        if (knownItem.getAttachments().length === 0) tryDownloadPDFBackground(knownItem, paper);
      }
      return knownItem;
    }
  }

  // Check for duplicates: DOI → ISBN → PMID → title
  const existing = await findExisting(paper);
  if (existing) {
    Zotero.log("[InstantCite] Paper already in library: " + paper.title);
    (paper as any)._zoteroItemId = existing.id;
    // Fix items that were previously saved without authors
    if (existing.getCreators().length === 0 && paper.authors.length > 0) {
      try {
        Zotero.log("[InstantCite] Updating missing authors for existing item");
        await addAuthorsToItem(existing, paper);
      } catch (e) {
        Zotero.log("[InstantCite] Failed to update authors: " + e);
      }
    }
    if (!skipPDF && isAutoDownloadPDF()) {
      const attachmentIds = existing.getAttachments();
      if (attachmentIds.length === 0) {
        tryDownloadPDFBackground(existing, paper);
      }
    }
    return existing;
  }

  const itemType = paper.itemType || (paper.isbn ? "book" : "journalArticle");
  const item = new Zotero.Item(itemType);
  const libraryID = Zotero.Libraries.userLibraryID;
  item.libraryID = libraryID;

  // Set fields — title and date work for all item types
  item.setField("title", paper.title);
  item.setField("date", String(paper.year));

  // Type-specific fields
  if (itemType === "case") {
    // Court case fields
    if (paper.court) trySetField(item, "court", paper.court);
    if (paper.caseNumber) trySetField(item, "docketNumber", paper.caseNumber);
    if (paper.url) trySetField(item, "url", paper.url);
    if (paper.abstract) item.setField("abstractNote", paper.abstract);
  } else if (itemType === "statute") {
    // Legislation fields
    if (paper.url) trySetField(item, "url", paper.url);
    if (paper.abstract) item.setField("abstractNote", paper.abstract);
  } else {
    // Academic item fields (journalArticle, book, etc.)
    if (paper.journal && itemType !== "book") item.setField("publicationTitle", paper.journal);
    if (paper.journal && itemType === "book") item.setField("publisher", paper.journal);
    if (paper.publisher && itemType === "book" && !paper.journal) item.setField("publisher", paper.publisher);
    if (paper.journalAbbreviation) trySetField(item, "journalAbbreviation", paper.journalAbbreviation);
    if (paper.issn) trySetField(item, "ISSN", paper.issn);
    if (paper.volume) item.setField("volume", paper.volume);
    if (paper.issue) item.setField("issue", paper.issue);
    if (paper.pages) item.setField("pages", paper.pages);
    if (paper.place) trySetField(item, "place", paper.place);
    if (paper.doi) item.setField("DOI", paper.doi);
    if (paper.isbn) item.setField("ISBN", paper.isbn);
    if (paper.abstract) item.setField("abstractNote", paper.abstract);
  }

  // Extra field for additional identifiers
  const extraParts: string[] = [];
  if (paper.pmid) extraParts.push("PMID: " + paper.pmid);
  if (paper.openalexId) extraParts.push("OpenAlex: " + paper.openalexId);
  if (paper.citationCount && paper.itemType !== "case") extraParts.push("Citations: " + paper.citationCount);
  if (paper.ecli) extraParts.push("ECLI: " + paper.ecli);
  if (paper.celex) extraParts.push("CELEX: " + paper.celex);
  if (extraParts.length > 0) {
    item.setField("extra", extraParts.join("\n"));
  }

  // Authors
  await addAuthorsToItem(item, paper);

  // Cache the newly created item's ID to prevent duplicates on future calls
  (paper as any)._zoteroItemId = item.id;

  // Download PDF in background (don't block cite flow)
  if (!skipPDF && isAutoDownloadPDF()) {
    tryDownloadPDFBackground(item, paper);
  }

  Zotero.log("[InstantCite] Added: " + paper.title);
  return item;
}

/** Add authors to a Zotero item and save */
async function addAuthorsToItem(item: Zotero.Item, paper: PaperResult) {
  const validAuthors = paper.authors.filter(a => a.name.trim() !== "");
  for (const author of validAuthors) {
    // Prefer structured data the API already gave us — bypass heuristics.
    // Only fall through to parseAuthorName/isCorporateAuthor when the source
    // provided nothing but a free-form string (DOAJ, Open Library).
    const hasStructured = !!(author.lastName || author.firstName || author.isCorporate);

    if (hasStructured) {
      if (author.isCorporate) {
        item.setCreator(item.getCreators().length, {
          lastName: (author.lastName || author.name).trim(),
          creatorType: "author",
          fieldMode: 1,
        } as any);
      } else {
        item.setCreator(item.getCreators().length, {
          firstName: (author.firstName || "").trim(),
          lastName: (author.lastName || "").trim(),
          creatorType: "author",
        });
      }
      continue;
    }

    // Unstructured fallback
    if (isCorporateAuthor(author.name)) {
      item.setCreator(item.getCreators().length, {
        lastName: author.name,
        creatorType: "author",
        fieldMode: 1,
      } as any);
    } else {
      const { lastName, firstName } = parseAuthorName(author.name);
      item.setCreator(item.getCreators().length, {
        firstName,
        lastName,
        creatorType: "author",
      });
    }
  }
  await item.saveTx();
}

/** Check if author name looks like a corporate/collaborative group */
export function isCorporateAuthor(name: string): boolean {
  const lower = name.toLowerCase();

  // Academic/research group patterns
  const academicTerms = [
    "collaborat", "consortium", "committee", "group", "network",
    "initiative", "project", "investigators", "working",
    "organization", "organisation", "society", "association",
    "council", "foundation", "institute", "center", "centre", "team",
    "university", "college", "academy", "laboratory", "laborator",
    "database", "registry", "observatory", "repository", "panel",
    "survey", "study group", "forum", "task force",
  ];

  // Legal/governmental entity patterns
  const legalTerms = [
    "court", "tribunal", "appeals", "supreme", "district",
    "circuit", "federal", "state of", "republic", "kingdom",
    "ministry", "department", "commission", "agency", "bureau",
    "office of", "board of", "authority", "administration",
    "government", "parliament", "congress", "senate",
    "united states", "united nations", "european",
  ];

  // Medical/corporate patterns
  const orgTerms = [
    "hospital", "clinic", "corporation", "company", "inc.",
    "ltd.", "llc", "gmbh", "s.r.l.", "s.a.",
  ];

  for (const term of [...academicTerms, ...legalTerms, ...orgTerms]) {
    if (lower.includes(term)) return true;
  }

  // If name has more than 5 words, likely a group name
  if (name.trim().split(/\s+/).length > 5) return true;

  // Pattern: "X of Y" or "X v. Y" (legal case parties are NOT corporate — handle elsewhere)
  return false;
}

/** Safely set a field, ignoring errors for unsupported fields */
function trySetField(item: Zotero.Item, field: string, value: string) {
  try { item.setField(field as any, value); } catch { /* field not valid for this item type */ }
}

/** Fire-and-forget PDF download with landing-page-URL fallback — doesn't block the caller */
function tryDownloadPDFBackground(item: Zotero.Item, paper: PaperResult) {
  ensurePDFOrLandingLink(item, paper).catch(e => {
    Zotero.log("[InstantCite] Background PDF/link save failed: " + e);
  });
}

/**
 * Try to download a PDF; if no PDF is available, save a link attachment to the
 * landing page so the user still has one click to reach the source.
 */
async function ensurePDFOrLandingLink(item: Zotero.Item, paper: PaperResult) {
  const downloaded = await tryDownloadPDF(item, paper);
  if (downloaded) return;
  await trySaveLandingLink(item, paper);
}

/** Save a link-mode attachment pointing at the landing page (DOI / paper URL). */
async function trySaveLandingLink(item: Zotero.Item, paper: PaperResult) {
  const url = paper.doi
    ? "https://doi.org/" + paper.doi
    : (paper.url || paper.pdfUrl || null);
  if (!url) return;

  // Avoid duplicate link attachments — Zotero stores the URL on the attachment
  // item's `url` field. Skip if any existing attachment already points there.
  const existingIds = item.getAttachments();
  for (const attId of existingIds) {
    const att = Zotero.Items.get(attId);
    if (!att) continue;
    try {
      if (att.getField("url") === url) return;
    } catch { /* not all attachments have url field */ }
  }

  const title = paper.doi ? "DOI page" : "Source page";
  try {
    if (typeof (Zotero.Attachments as any).linkFromURL === "function") {
      await (Zotero.Attachments as any).linkFromURL({
        libraryID: item.libraryID,
        parentItemID: item.id,
        url,
        title,
        contentType: "text/html",
      });
      Zotero.log("[InstantCite] Saved landing-page link: " + url);
    }
  } catch (e) {
    Zotero.log("[InstantCite] Failed to save landing-page link: " + e);
  }
}

/**
 * Open paper: if already in Zotero with a PDF, open PDF locally.
 * Otherwise, open DOI/URL in the default browser.
 */
export async function openPaperOrPDF(paper: PaperResult) {
  // Check if paper exists in Zotero with a PDF attachment
  const existing = await findExisting(paper);
  if (existing) {
    const attachmentIds = existing.getAttachments();
    for (const attId of attachmentIds) {
      const att = Zotero.Items.get(attId);
      if (att && att.attachmentContentType === "application/pdf") {
        const path = await att.getFilePathAsync();
        if (path) {
          Zotero.log("[InstantCite] Opening local PDF: " + path);
          Zotero.launchFile(path);
          return;
        }
      }
    }
  }

  // No local PDF — open in browser
  const url = paper.doi ? "https://doi.org/" + paper.doi : (paper.pdfUrl || paper.url || null);
  if (url) {
    Zotero.launchURL(url);
    Zotero.log("[InstantCite] Opened in browser: " + url);
  }
}

/**
 * Force-download PDF and open it in the default PDF viewer.
 * Unlike tryDownloadPDFBackground, this is explicit (ignores auto-download pref)
 * and opens the file after download.
 * @returns "downloaded" | "opened" | "not_found"
 */
export async function downloadAndOpenPDF(item: Zotero.Item, paper: PaperResult): Promise<"downloaded" | "opened" | "not_found"> {
  // Check if item already has a PDF attachment
  const existingAttachments = item.getAttachments();
  for (const attId of existingAttachments) {
    const att = Zotero.Items.get(attId);
    if (att && att.attachmentContentType === "application/pdf") {
      const path = await att.getFilePathAsync();
      if (path) {
        Zotero.log("[InstantCite] Opening existing PDF: " + path);
        Zotero.launchFile(path);
        return "opened";
      }
    }
  }

  // No existing PDF — download it
  Zotero.log("[InstantCite] Downloading PDF for: " + paper.title);
  await tryDownloadPDF(item, paper);

  // Find the newly attached PDF and open it
  const newAttachments = item.getAttachments();
  for (const attId of newAttachments) {
    const att = Zotero.Items.get(attId);
    if (att && att.attachmentContentType === "application/pdf") {
      const path = await att.getFilePathAsync();
      if (path) {
        Zotero.log("[InstantCite] Opening downloaded PDF: " + path);
        Zotero.launchFile(path);
        return "downloaded";
      }
    }
  }

  Zotero.log("[InstantCite] No PDF was downloaded — may not be available");
  // Fallback: at least save the landing page so the user has one-click access
  await trySaveLandingLink(item, paper);
  return "not_found";
}

/** Returns true if a PDF was actually attached to the item. */
async function tryDownloadPDF(item: Zotero.Item, paper: PaperResult): Promise<boolean> {
  const libraryID = item.libraryID;

  // 1. If we have a direct PDF URL, use it
  if (paper.pdfUrl) {
    try {
      await Zotero.Attachments.importFromURL({
        libraryID,
        url: paper.pdfUrl,
        parentItemID: item.id,
        contentType: "application/pdf",
      });
      if (hasPDFAttachment(item)) return true;
    } catch (e) {
      Zotero.log("[InstantCite] Direct PDF download failed: " + e);
    }
  }

  // 2. If article is Open Access or has a DOI, try Zotero's built-in PDF finder.
  //    These helpers don't throw on "no PDF found" — they silently add nothing,
  //    so we have to detect success by checking attachments after the call.
  if (paper.doi || paper.isOpenAccess) {
    try {
      if (typeof (Zotero.Attachments as any).addAvailableFile === "function") {
        await (Zotero.Attachments as any).addAvailableFile(item);
      } else if (typeof (Zotero.Attachments as any).addAvailablePDF === "function") {
        await (Zotero.Attachments as any).addAvailablePDF(item);
      }
      if (hasPDFAttachment(item)) return true;
    } catch (e) {
      Zotero.log("[InstantCite] Auto PDF finder failed: " + e);
    }
  }

  return false;
}

function hasPDFAttachment(item: Zotero.Item): boolean {
  for (const attId of item.getAttachments()) {
    const att = Zotero.Items.get(attId);
    if (att && att.attachmentContentType === "application/pdf") return true;
  }
  return false;
}

export function parseAuthorName(name: string): { lastName: string; firstName: string } {
  const trimmed = name.trim();
  if (!trimmed) return { lastName: "", firstName: "" };

  // Format 1: "Last, First" (comma-separated — most databases)
  if (trimmed.includes(",")) {
    const [last, ...rest] = trimmed.split(",");
    return { lastName: last.trim(), firstName: rest.join(",").trim() };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length <= 1) return { lastName: parts[0], firstName: "" };

  // Format 2: "LastName INITIALS" (e.g. "Smith JA", "Zhang WL")
  // Last part is all uppercase and short → initials (firstName), rest is lastName
  const lastPart = parts[parts.length - 1];
  if (lastPart.length <= 3 && lastPart === lastPart.toUpperCase() && /^[A-Z]+$/.test(lastPart)) {
    return { lastName: parts.slice(0, -1).join(" "), firstName: lastPart };
  }

  // Format 3: "First Last" (natural order — 2 parts)
  // Last part is lastName, rest is firstName
  return { lastName: parts[parts.length - 1], firstName: parts.slice(0, -1).join(" ") };
}

/** Find existing item by DOI, ISBN, PMID (in extra), or exact title */
async function findExisting(paper: PaperResult): Promise<Zotero.Item | null> {
  const libraryID = Zotero.Libraries.userLibraryID;

  // 1. DOI
  if (paper.doi) {
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("DOI", "is", paper.doi);
    const ids = await s.search();
    if (ids.length > 0) return Zotero.Items.get(ids[0]);
  }

  // 2. ISBN
  if (paper.isbn) {
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("ISBN", "is", paper.isbn);
    const ids = await s.search();
    if (ids.length > 0) return Zotero.Items.get(ids[0]);
  }

  // 3. PMID (stored in Extra field)
  if (paper.pmid) {
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("extra", "contains", "PMID: " + paper.pmid);
    const ids = await s.search();
    if (ids.length > 0) return Zotero.Items.get(ids[0]);
  }

  // 4. Exact title match (case-insensitive via Zotero search)
  if (paper.title && paper.title.length > 10) {
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("title", "is", paper.title);
    const ids = await s.search();
    if (ids.length > 0) return Zotero.Items.get(ids[0]);
  }

  return null;
}
