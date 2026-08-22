import type { PaperResult, SearchResponse } from "./types";
import { sortItemIdsByDocumentPriority } from "../utils/document-priority";
import { detectQueryType } from "../utils/query-detector";

/**
 * Pick the search condition that can actually match the query.
 *
 * `quicksearch-titleCreatorYear` covers title, creator and year — and nothing
 * else. Feeding it a DOI or a PMID matches zero items, so an identifier lookup
 * used to report "not in your library" for papers that are in it, and the copy
 * cited in the document never appeared in the results at all.
 */
export function addQueryCondition(search: any, query: string): void {
  const detection = detectQueryType(query);
  const identifierField = detection.type === "DOI" ? "DOI"
    : detection.type === "PMID" ? "extra"   // Zotero stores PMIDs in Extra
    : null;

  if (identifierField) {
    try {
      // "contains", not "is": stored DOIs often keep the https://doi.org/
      // prefix, and Extra holds the PMID among other lines.
      search.addCondition(identifierField, "contains", detection.value);
      return;
    } catch {
      // Field unsupported in this Zotero build — fall back to quicksearch.
    }
  }

  search.addCondition("quicksearch-titleCreatorYear", "contains", query);
}

export function selectLocalSearchItemIds(
  itemIds: number[],
  prioritizedItemIds?: Set<number>,
  maxResults = 100,
): number[] {
  return sortItemIdsByDocumentPriority(itemIds.slice(0, maxResults), prioritizedItemIds);
}

/**
 * Search the local Zotero library using Zotero.Search API.
 * Searches title, creator, DOI, and ISBN fields.
 */
export async function searchZoteroLocal(options: {
  query: string;
  yearFrom?: number;
  yearTo?: number;
  prioritizedItemIds?: Set<number>;
}): Promise<SearchResponse> {
  const start = Date.now();

  const search = new Zotero.Search();
  search.libraryID = Zotero.Libraries.userLibraryID;

  // Keyword queries mimic the Zotero search bar; DOI/PMID queries are matched
  // against the field that actually holds them.
  addQueryCondition(search, options.query);

  // Only regular items (not notes, attachments)
  search.addCondition("itemType", "isNot", "attachment");
  search.addCondition("itemType", "isNot", "note");

  if (options.yearFrom) {
    search.addCondition("date", "isAfter", `${options.yearFrom - 1}-12-31`);
  }
  if (options.yearTo) {
    search.addCondition("date", "isBefore", `${options.yearTo + 1}-01-01`);
  }

  const itemIds: number[] = await search.search();
  if (!itemIds || itemIds.length === 0) {
    return { source: "Zotero", results: [], totalCount: 0, searchTimeMs: Date.now() - start };
  }

  // Limit to first 100 items to avoid freezing Zotero with large libraries
  const MAX_LOCAL_RESULTS = 100;
  // Keep Zotero's own ordering intact while limiting the set, then move cited
  // items to the top inside that preserved window. This avoids pushing relevant
  // results out of the top 100 just because they are not already in the doc.
  const limitedIds = selectLocalSearchItemIds(itemIds, options.prioritizedItemIds, MAX_LOCAL_RESULTS);
  const items = await Zotero.Items.getAsync(limitedIds);

  const results: PaperResult[] = [];
  for (const item of items) {
    if (!item || item.isNote() || item.isAttachment()) continue;
    try {
      results.push(zoteroItemToPaperResult(item));
    } catch (err) {
      Zotero.log("[InstantCite] Error converting Zotero item " + item.id + ": " + err);
    }
  }

  return {
    source: "Zotero",
    results,
    totalCount: itemIds.length,
    searchTimeMs: Date.now() - start,
  };
}

function zoteroItemToPaperResult(item: any): PaperResult {
  const creators = item.getCreators() || [];
  const authors = creators
    .filter((c: any) => c.creatorTypeID === Zotero.CreatorTypes.getID("author") || creators.length <= 2)
    .map((c: any) => {
      const isCorp = c.fieldMode === 1;
      const last = (c.lastName || "").trim();
      const first = (c.firstName || "").trim();
      return {
        name: isCorp ? last : [first, last].filter(Boolean).join(" "),
        lastName: last,
        firstName: isCorp ? undefined : first,
        isCorporate: isCorp || undefined,
      };
    })
    .filter((a: { name: string }) => a.name.trim() !== "");

  const dateStr = item.getField("date") as string || "";
  const yearMatch = dateStr.match(/(\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : 0;

  const doi = (item.getField("DOI") as string) || "";
  const isbn = (item.getField("ISBN") as string) || "";
  const pmid = (item.getField("extra") as string)?.match(/PMID:\s*(\d+)/)?.[1] || "";

  const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
  const journal = itemType === "book"
    ? (item.getField("publisher") as string) || ""
    : (item.getField("publicationTitle") as string) || "";

  const abstractText = (item.getField("abstractNote") as string) || "";

  // Journal metadata that may already exist in the Zotero item
  const pages = (item.getField("pages") as string) || undefined;
  const volume = (item.getField("volume") as string) || undefined;
  const issue = (item.getField("issue") as string) || undefined;
  const journalAbbreviation = (item.getField("journalAbbreviation") as string) || undefined;
  const issn = (item.getField("ISSN") as string) || undefined;

  return {
    id: "zotero-local:" + item.id,
    title: (item.getField("title") as string) || "Untitled",
    authors,
    year,
    journal: journal || undefined,
    journalAbbreviation,
    issn,
    volume,
    issue,
    pages,
    doi: doi || undefined,
    pmid: pmid || undefined,
    isbn: isbn || undefined,
    abstract: abstractText || undefined,
    isOpenAccess: false,
    sources: ["Zotero"],
    _zoteroItemId: item.id,
  } as PaperResult & { _zoteroItemId: number };
}
