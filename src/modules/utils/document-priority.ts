import type { PaperResult } from "../api/types";

export function getPaperZoteroItemId(paper: PaperResult): number | null {
  const raw = (paper as any)._zoteroItemId;
  const id = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Provenance tiers, lowest first. This is a hard ordering: a result from a
 * lower tier always outranks one from a higher tier, no matter its relevance
 * score. Relevance only decides the order *inside* a tier.
 *
 * The library tier used to be expressed as a +50 relevance bonus, which is not
 * an ordering at all — a well-matching CrossRef hit (title + phrase + citation
 * bonuses) easily outscored a library item whose title only partly matched, so
 * papers the user already owns dropped below internet noise.
 */
export const TIER_DOCUMENT = 0;
export const TIER_LIBRARY = 1;
export const TIER_EXTERNAL = 2;

export function getProvenanceTier(paper: PaperResult, documentItemIds?: Set<number>): number {
  const id = getPaperZoteroItemId(paper);
  if (id && documentItemIds?.has(id)) return TIER_DOCUMENT;
  if (id || paper.sources.includes("Zotero")) return TIER_LIBRARY;
  return TIER_EXTERNAL;
}

/**
 * Order results as: cited in the current document → in the local library →
 * everything else. Stable, so whatever ranking produced `papers` survives
 * within each tier.
 */
export function sortByProvenance<T extends PaperResult>(
  papers: T[],
  documentItemIds?: Set<number>,
): T[] {
  return papers
    .map((paper, index) => ({ paper, index }))
    .sort((a, b) => {
      const tierDiff = getProvenanceTier(a.paper, documentItemIds)
        - getProvenanceTier(b.paper, documentItemIds);
      return tierDiff !== 0 ? tierDiff : a.index - b.index;
    })
    .map(({ paper }) => paper);
}

export function sortItemIdsByDocumentPriority(
  itemIds: number[],
  documentItemIds?: Set<number>,
): number[] {
  if (!documentItemIds || documentItemIds.size === 0) return itemIds;
  return itemIds
    .map((id, index) => ({ id, index }))
    .sort((a, b) => {
      const aInDoc = documentItemIds.has(a.id) ? 1 : 0;
      const bInDoc = documentItemIds.has(b.id) ? 1 : 0;
      if (aInDoc !== bInDoc) return bInDoc - aInDoc;
      return a.index - b.index;
    })
    .map(({ id }) => id);
}

export function extractDocumentItemIds(citationsByItemID: unknown): Set<number> {
  if (!citationsByItemID) return new Set();

  const rawIds = citationsByItemID instanceof Map
    ? Array.from(citationsByItemID.keys())
    : Object.keys(citationsByItemID as Record<string, unknown>);

  return new Set(
    rawIds
      .map(id => typeof id === "number" ? id : parseInt(String(id), 10))
      .filter(id => Number.isFinite(id) && id > 0),
  );
}

export function extractCitationItemIds(citationItems: unknown): Set<number> {
  if (!Array.isArray(citationItems)) return new Set();
  return new Set(
    citationItems
      .map((item: any) => item?.id ?? item?.itemID)
      .map(id => typeof id === "number" ? id : parseInt(String(id ?? ""), 10))
      .filter(id => Number.isFinite(id) && id > 0),
  );
}
