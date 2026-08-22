/**
 * Fix DOIs — library-wide DOI/title concordance repair.
 *
 * Items imported from reference lists routinely carry a DOI that belongs to a
 * different article: the title, authors and journal describe paper A while the
 * DOI resolves to paper B. This sweeps the library for that defect and repairs
 * it without breaking anything downstream:
 *
 * - the DOI is corrected **on the existing item**, so its key never changes and
 *   Word/LibreOffice citations stay linked;
 * - the article the wrong DOI pointed to is saved as a **new item**, because a
 *   wrong DOI is still a real reference somebody meant to cite.
 *
 * `item-updater.ts` performs a broad metadata refresh on hand-picked items.
 * This is the opposite: one field, the whole library, and a hard rule that a
 * failed lookup never licenses a write.
 */

import {
  DOI_BATCH_SIZE,
  lookupCrossRefDOI,
  lookupCrossRefDOIBatch,
  searchCrossRef,
} from "./api/crossref";
import { searchEuropePMC } from "./api/europepmc";
import { addToZotero } from "./zotero-bridge";
import { titleSimilarity } from "./utils/deduplicator";
import {
  europePmcDoiQuery,
  isWellFormedDoi,
  normalizeDoi,
  sameDoi,
  titlesAgree,
} from "./utils/doi";
import type { PaperResult } from "./api/types";

/** Similarity a title-search hit must reach before it may rewrite a DOI. */
export const TITLE_MATCH_MIN = 0.85;

/** Tag applied to items whose DOI was wrong and whose real DOI we could not find. */
export const REVIEW_TAG = "InstantCite: DOI de verificat";

export type DoiVerdict = "ok" | "mismatch" | "dead" | "malformed";

export interface DoiFixPlan {
  /** `repair` writes a corrected DOI; `orphan` clears the field instead. */
  kind: "repair" | "orphan";
  oldDoi: string;
  /** The corrected DOI, or null when none was found. */
  newDoi: string | null;
  clearDoi: boolean;
  /** Line appended to Extra so the original value is never silently lost. */
  extraLine: string;
  tags: string[];
  /**
   * The article the old DOI actually pointed to, saved as a new item.
   * Null for a malformed DOI — it never resolved, so there is nothing to save.
   */
  recoverFrom: PaperResult | null;
}

export interface DoiFinding {
  itemId: number;
  title: string;
  verdict: DoiVerdict;
  oldDoi: string;
  /** Title of the record the old DOI resolved to, for display. */
  resolvedTitle: string;
  plan: DoiFixPlan | null;
}

export interface ApplyOutcome {
  itemId: number;
  title: string;
  /** What happened to the source item. */
  repaired: "doi-corrected" | "doi-cleared";
  newDoi: string | null;
  /** Title of the recovered reference, if one was created. */
  createdTitle: string | null;
  /** True when the recovered article was already in the library. */
  alreadyPresent: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Pure decision logic — no Zotero, no HTTP. This is what the tests exercise.
// ---------------------------------------------------------------------------

/**
 * Does this DOI belong to the article the item describes?
 *
 * A malformed DOI is classified without any lookup: CrossRef 404s on
 * "10.1016/j.pec.2021." while a free-text search matches hundreds of unrelated
 * papers, so a fragment must never be resolved as if it were an identifier.
 *
 * A failed lookup yields `dead`, never `mismatch` — an unreachable API is not
 * evidence that a DOI is wrong.
 */
export function classifyDoiCheck(
  itemTitle: string | undefined | null,
  doi: string | undefined | null,
  resolved: { title?: string } | null,
): DoiVerdict {
  if (!isWellFormedDoi(doi)) return "malformed";
  if (!resolved) return "dead";
  return titlesAgree(itemTitle, resolved.title) ? "ok" : "mismatch";
}

/**
 * Turn a verdict plus whatever the title search found into an action plan.
 * Returns null when nothing should be written.
 */
export function planDoiFix(opts: {
  verdict: DoiVerdict;
  oldDoi: string;
  /** Record the old DOI resolved to. Null for `malformed` and `dead`. */
  resolved: PaperResult | null;
  /** Best title-search hit for the item's own title, or null. */
  titleMatch: PaperResult | null;
}): DoiFixPlan | null {
  const { verdict, titleMatch } = opts;
  if (verdict === "ok" || verdict === "dead") return null;

  const oldDoi = normalizeDoi(opts.oldDoi);
  const newDoi = normalizeDoi(titleMatch?.doi);

  // The title search landed back on the DOI we started from. The two sources
  // contradict each other, which means the title comparison was the unreliable
  // one — leave the item alone rather than guess.
  if (newDoi && sameDoi(oldDoi, newDoi)) return null;

  // A malformed DOI never resolved to anything, so there is no article to save.
  const recoverFrom = verdict === "malformed" ? null : opts.resolved;
  const extraLine = `Wrong DOI: ${oldDoi}`;

  if (newDoi) {
    return {
      kind: "repair",
      oldDoi,
      newDoi,
      clearDoi: false,
      extraLine,
      tags: [],
      recoverFrom,
    };
  }

  return {
    kind: "orphan",
    oldDoi,
    newDoi: null,
    clearDoi: true,
    extraLine,
    tags: [REVIEW_TAG],
    recoverFrom,
  };
}

/** Best candidate above `min` similarity to the item's title, or null. */
export function bestTitleMatch(
  title: string,
  candidates: PaperResult[],
  min: number = TITLE_MATCH_MIN,
): PaperResult | null {
  let bestScore = min;
  let best: PaperResult | null = null;
  for (const p of candidates) {
    if (!p?.title || !p?.doi) continue;
    const score = titleSimilarity(title, p.title);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Zotero field access
// ---------------------------------------------------------------------------

function safeGetField(item: any, field: string): string {
  try {
    return ((item.getField(field) as string) ?? "").toString();
  } catch {
    return "";
  }
}

function safeSetField(item: any, field: string, value: string): boolean {
  try {
    item.setField(field, value);
    return true;
  } catch (err) {
    try { Zotero.log("[InstantCite] doi-fixer setField('" + field + "') skipped: " + err); } catch { /* ignore */ }
    return false;
  }
}

/**
 * The item's DOI, from the native field or from an `DOI: ...` line in Extra
 * (where item types without a DOI field keep it).
 */
export function readItemDoi(item: any): { doi: string; inExtra: boolean } {
  const field = normalizeDoi(safeGetField(item, "DOI"));
  if (field) return { doi: field, inExtra: false };

  const extra = safeGetField(item, "extra");
  const match = extra.match(/^\s*DOI:\s*(\S+)\s*$/im);
  const fromExtra = normalizeDoi(match?.[1]);
  return { doi: fromExtra, inExtra: !!fromExtra };
}

/** Write the DOI back where it was read from. */
function writeItemDoi(item: any, value: string, inExtra: boolean): boolean {
  if (!inExtra) return safeSetField(item, "DOI", value);

  const extra = safeGetField(item, "extra");
  const next = value
    ? extra.replace(/^\s*DOI:\s*\S+\s*$/im, `DOI: ${value}`)
    : extra.replace(/^\s*DOI:\s*\S+\s*$\n?/im, "");
  return safeSetField(item, "extra", next.trim());
}

function appendExtraLine(item: any, line: string) {
  const extra = safeGetField(item, "extra");
  if (extra.includes(line)) return;
  safeSetField(item, "extra", extra ? `${extra}\n${line}` : line);
}

/** Any non-trashed item in the user library carrying this DOI. */
async function findItemByDoi(doi: string): Promise<any | null> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  try {
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("DOI", "is", normalized);
    const ids = await s.search();
    for (const id of ids) {
      const found = Zotero.Items.get(id);
      if (found && !found.deleted) return found;
    }
  } catch (err) {
    // Not fatal — addToZotero deduplicates by DOI too — but it means the
    // "already in library" report below is unreliable, so say so.
    try { Zotero.log("[InstantCite] doi-fixer: DOI search failed for " + normalized + " — " + err); } catch { /* ignore */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export interface ScanOptions {
  onProgress?: (done: number, total: number, phase: "resolve" | "search") => void;
  shouldCancel?: () => boolean;
}

interface Candidate {
  item: any;
  itemId: number;
  title: string;
  doi: string;
  inExtra: boolean;
}

/** Every top-level item in the user library that carries a DOI. */
async function collectCandidates(): Promise<Candidate[]> {
  const s = new Zotero.Search();
  s.libraryID = Zotero.Libraries.userLibraryID;
  s.addCondition("noChildren", "true" as any);
  const ids = await s.search();

  const candidates: Candidate[] = [];
  for (const id of ids) {
    const item = Zotero.Items.get(id);
    if (!item || item.isNote() || item.isAttachment() || (item as any).deleted) continue;
    const { doi, inExtra } = readItemDoi(item);
    if (!doi) continue;
    candidates.push({
      item,
      itemId: id,
      title: safeGetField(item, "title").trim(),
      doi,
      inExtra,
    });
  }
  return candidates;
}

/** Resolve one DOI on its own: CrossRef first, then Europe PMC. */
async function resolveSingleDoi(doi: string): Promise<PaperResult | null> {
  try {
    const resp = await lookupCrossRefDOI(doi);
    if (resp.results[0]) return resp.results[0];
  } catch { /* fall through to Europe PMC */ }
  try {
    const resp = await searchEuropePMC({ query: europePmcDoiQuery(doi), maxResults: 1 });
    if (resp.results[0]) return resp.results[0];
  } catch { /* unresolvable */ }
  return null;
}

/** Find the article the item's title describes, so its real DOI can be read off. */
async function findByTitle(title: string): Promise<PaperResult | null> {
  if (title.length < 15) return null;
  const query = title.slice(0, 100).replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

  try {
    const resp = await searchCrossRef({ query, maxResults: 5 });
    const best = bestTitleMatch(title, resp.results);
    if (best) return best;
  } catch { /* try Europe PMC */ }
  try {
    const resp = await searchEuropePMC({ query, maxResults: 5 });
    return bestTitleMatch(title, resp.results);
  } catch { /* nothing found */ }
  return null;
}

/**
 * Scan the whole library and return one finding per item with a DOI problem.
 * Writes nothing — the caller decides what to apply.
 */
export async function scanLibraryForDoiIssues(opts: ScanOptions = {}): Promise<DoiFinding[]> {
  const cancelled = () => opts.shouldCancel?.() === true;
  const candidates = await collectCandidates();
  const total = candidates.length;
  Zotero.log(`[InstantCite] DOI fixer: ${total} items carry a DOI`);

  // Phase 1 — resolve. Well-formed DOIs go out in batches; malformed ones are
  // classified without a lookup.
  const resolved = new Map<number, PaperResult | null>();
  const batchable = candidates.filter(c => isWellFormedDoi(c.doi));
  let done = total - batchable.length;
  opts.onProgress?.(done, total, "resolve");

  for (let i = 0; i < batchable.length; i += DOI_BATCH_SIZE) {
    if (cancelled()) return [];
    const chunk = batchable.slice(i, i + DOI_BATCH_SIZE);

    let hits = new Map<string, PaperResult>();
    try {
      hits = await lookupCrossRefDOIBatch(chunk.map(c => c.doi));
    } catch (e) {
      try { Zotero.log("[InstantCite] DOI fixer: batch failed, falling back — " + e); } catch { /* ignore */ }
    }

    for (const c of chunk) {
      const hit = hits.get(c.doi.toLowerCase());
      // Absent from the batch is not proof of absence — confirm one by one.
      resolved.set(c.itemId, hit ?? await resolveSingleDoi(c.doi));
      done++;
    }
    opts.onProgress?.(done, total, "resolve");
  }

  // Phase 2 — for defective items only, find the real article by title.
  const suspects = candidates.filter(c => {
    const verdict = classifyDoiCheck(c.title, c.doi, resolved.get(c.itemId) ?? null);
    return verdict === "mismatch" || verdict === "malformed";
  });
  Zotero.log(`[InstantCite] DOI fixer: ${suspects.length} suspect DOIs, searching by title`);

  const findings: DoiFinding[] = [];
  let searched = 0;
  for (const c of suspects) {
    if (cancelled()) return findings;
    const record = resolved.get(c.itemId) ?? null;
    const verdict = classifyDoiCheck(c.title, c.doi, record);
    const titleMatch = await findByTitle(c.title);
    const plan = planDoiFix({ verdict, oldDoi: c.doi, resolved: record, titleMatch });

    if (plan) {
      findings.push({
        itemId: c.itemId,
        title: c.title || "Untitled",
        verdict,
        oldDoi: c.doi,
        resolvedTitle: record?.title ?? "",
        plan,
      });
    }
    searched++;
    opts.onProgress?.(searched, suspects.length, "search");
  }

  // Dead DOIs are reported but never repaired — a DOI that resolves nowhere is
  // a data-quality signal, not evidence that it belongs to another article.
  for (const c of candidates) {
    if (classifyDoiCheck(c.title, c.doi, resolved.get(c.itemId) ?? null) !== "dead") continue;
    findings.push({
      itemId: c.itemId,
      title: c.title || "Untitled",
      verdict: "dead",
      oldDoi: c.doi,
      resolvedTitle: "",
      plan: null,
    });
  }

  Zotero.log(`[InstantCite] DOI fixer: ${findings.length} findings`);
  return findings;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Execute one plan.
 *
 * The source item is saved **before** the recovered reference is created. This
 * ordering is load-bearing: `addToZotero` deduplicates by DOI, so if the
 * recovery ran first it would match the source item on the DOI we are trying to
 * move away from and return it instead of creating anything.
 */
export async function applyDoiFixPlan(item: any, plan: DoiFixPlan): Promise<ApplyOutcome> {
  const title = safeGetField(item, "title").trim() || "Untitled";
  const { inExtra } = readItemDoi(item);

  // 1. Repair the source item, keeping its key so citations stay linked.
  writeItemDoi(item, plan.clearDoi ? "" : (plan.newDoi ?? ""), inExtra);
  appendExtraLine(item, plan.extraLine);
  for (const tag of plan.tags) {
    try {
      item.addTag(tag);
    } catch (err) {
      // The DOI was still cleared, so losing the tag means losing the only
      // marker that this item needs a human look.
      try { Zotero.log("[InstantCite] doi-fixer: addTag('" + tag + "') failed — " + err); } catch { /* ignore */ }
    }
  }
  await item.saveTx();

  const outcome: ApplyOutcome = {
    itemId: item.id,
    title,
    repaired: plan.clearDoi ? "doi-cleared" : "doi-corrected",
    newDoi: plan.newDoi,
    createdTitle: null,
    alreadyPresent: false,
  };

  // 2. Save the article the wrong DOI actually pointed to.
  if (!plan.recoverFrom) return outcome;

  try {
    const existing = await findItemByDoi(plan.oldDoi);
    if (existing) {
      outcome.alreadyPresent = true;
      outcome.createdTitle = safeGetField(existing, "title").trim() || plan.recoverFrom.title;
      return outcome;
    }

    const created = await addToZotero(plan.recoverFrom, true);
    outcome.createdTitle = plan.recoverFrom.title;

    // 3. File it alongside the item it was recovered from.
    const collections = (item.getCollections?.() ?? []) as number[];
    if (collections.length > 0) {
      for (const collectionID of collections) {
        try { (created as any).addToCollection(collectionID); } catch { /* ignore */ }
      }
      await created.saveTx();
    }
  } catch (e: any) {
    // The source item's repair is already committed and stands on its own.
    outcome.error = String(e?.message ?? e);
  }

  return outcome;
}

/** Apply a set of findings, skipping any whose item has since disappeared. */
export async function applyDoiFindings(findings: DoiFinding[]): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  for (const finding of findings) {
    if (!finding.plan) continue;
    const item = Zotero.Items.get(finding.itemId);
    if (!item) continue;
    try {
      outcomes.push(await applyDoiFixPlan(item, finding.plan));
    } catch (e: any) {
      outcomes.push({
        itemId: finding.itemId,
        title: finding.title,
        repaired: finding.plan.clearDoi ? "doi-cleared" : "doi-corrected",
        newDoi: finding.plan.newDoi,
        createdTitle: null,
        alreadyPresent: false,
        error: String(e?.message ?? e),
      });
    }
  }
  return outcomes;
}
