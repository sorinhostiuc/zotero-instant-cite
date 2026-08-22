import { searchPubMed } from "./api/pubmed";
import { searchCrossRef, lookupCrossRefDOI } from "./api/crossref";
import { searchOpenLibrary } from "./api/open-library";
import { searchEuropePMC } from "./api/europepmc";
import { searchDOAJ } from "./api/doaj";
import { searchECHR } from "./api/echr";
import { searchEurLex } from "./api/eurlex";
import { searchCourtListener } from "./api/courtlistener";
import { searchZoteroLocal } from "./api/zotero-local";
import { searchGoogleBooks } from "./api/google-books";
import { searchLoC } from "./api/loc";
import { detectQueryType } from "./utils/query-detector";
import { deduplicateResults } from "./utils/deduplicator";
import { rankResults, scoreRelevance } from "./utils/relevance";
import { sortByProvenance } from "./utils/document-priority";
import type { PaperResult, SearchOptions, SearchResponse } from "./api/types";

const ALL_SOURCES = [
  "Zotero", "PubMed", "EuropePMC", "CrossRef", "DOAJ", "OpenLibrary",
  "GoogleBooks", "LoC",
  "ECHR", "EUR-Lex", "CourtListener",
];

const EXTERNAL_SOURCES = [
  "PubMed", "EuropePMC", "CrossRef", "DOAJ", "OpenLibrary",
  "GoogleBooks", "LoC",
  "ECHR", "EUR-Lex", "CourtListener",
];

/** Similarity threshold — if best local result scores above this, skip external search */
const LOCAL_SUFFICIENT_SCORE = 35;

export interface OrchestratedResult {
  papers: PaperResult[];
  totalCount: number;
  sourceCounts: Record<string, number>;
  searchTimeMs: number;
  errors: Array<{ source: string; error: string }>;
  /** True if local results were sufficient and external search was skipped */
  localSufficient?: boolean;
  /** True if a DOI lookup found nothing and we fell back to text search across all sources */
  doiFallback?: boolean;
}

export async function orchestrateSearch(options: SearchOptions): Promise<OrchestratedResult> {
  const start = Date.now();
  const detection = detectQueryType(options.query);
  const errors: Array<{ source: string; error: string }> = [];
  const sourceCounts: Record<string, number> = {};
  let doiFallback = false;
  // For DOI queries, downstream ranking should compare against the normalized
  // DOI (without the https://doi.org/ prefix), so the relevance scorer can
  // detect exact DOI match.
  const effectiveQuery = detection.type === "DOI" ? detection.value : options.query;

  let allResults: PaperResult[] = [];

  // For direct ID lookups, only query the relevant source
  if (detection.type === "PMID") {
    // The local library is searched alongside PubMed — a PMID lookup that only
    // hits the internet would hide the copy the user already cited.
    const pmidOptions = { ...options, query: detection.value };
    const idSources = buildIdentifierSources(options, [
      { source: "PubMed", run: () => searchPubMed(pmidOptions) },
    ], pmidOptions, errors);
    const idResults = await Promise.all(idSources.map(s => s.promise));
    collectResults(idResults, idSources, allResults, sourceCounts);
  } else if (detection.type === "DOI") {
    // Fast path: local library + CrossRef /works/{DOI} (canonical) + PubMed
    // esearch with [doi] tag, in parallel. Either external source is enough to
    // identify the article unambiguously; the local hit is what keeps a paper
    // already in the document or the library at the top of the list.
    const doiOptions = { ...options, query: detection.value };
    const fastSources = buildIdentifierSources(options, [
      { source: "CrossRef", run: () => lookupCrossRefDOI(detection.value) },
      { source: "PubMed",   run: () => searchPubMed(doiOptions) },
    ], doiOptions, errors);
    const fastResults = await Promise.all(fastSources.map(s => s.promise));
    let foundAny = false;
    for (let i = 0; i < fastResults.length; i++) {
      const r = fastResults[i];
      if (r) {
        allResults.push(...r.results);
        sourceCounts[fastSources[i].source] = r.results.length;
        if (r.results.length > 0) foundAny = true;
      }
    }

    if (!foundAny) {
      // DOI not registered with any canonical source — fall back to text search
      // across every enabled source. The UI is told via `doiFallback` so it can
      // notify the user that the DOI lookup itself failed.
      doiFallback = true;
      const enabledSources = new Set(options.sources ?? ALL_SOURCES);
      // Zotero already ran above with the DOI matched against the DOI field —
      // a text search over the library would only add noise.
      enabledSources.delete("Zotero");
      // Also skip CrossRef + PubMed: we already tried the proper DOI lookup;
      // a text search there would just return the same noise that caused the
      // original bug.
      enabledSources.delete("CrossRef");
      enabledSources.delete("PubMed");
      const fallbackSearches = buildSearches(enabledSources, doiOptions, errors);
      const fallbackResults = await Promise.all(fallbackSearches.map(s => s.promise));
      collectResults(fallbackResults, fallbackSearches, allResults, sourceCounts);
    }
  } else {
    // Keyword search — Zotero-first strategy
    const enabledSources = new Set(options.sources ?? ALL_SOURCES);
    const zoteroEnabled = enabledSources.has("Zotero");

    // Phase 1: Search Zotero local first
    let localResults: PaperResult[] = [];
    if (zoteroEnabled) {
      const localResp = await safeSearch(() => searchZoteroLocal(options), "Zotero", errors);
      if (localResp && localResp.results.length > 0) {
        localResults = localResp.results;
        sourceCounts.Zotero = localResp.results.length;
      }
    }

    // Phase 2: Decide if external search is needed
    // Score local results against the query (without the +50 Zotero boost, to get a fair read)
    const bestLocalScore = localResults.reduce((best, paper) => {
      // Temporarily remove Zotero from sources to get unbiased score
      const tempPaper = { ...paper, sources: paper.sources.filter(s => s !== "Zotero") };
      const s = scoreRelevance(tempPaper, options.query);
      return Math.max(best, s);
    }, 0);

    const hasExternalSources = EXTERNAL_SOURCES.some(s => enabledSources.has(s));
    const localIsSufficient = bestLocalScore >= LOCAL_SUFFICIENT_SCORE && localResults.length >= 1;

    if (typeof Zotero !== "undefined") {
      Zotero.log("[InstantCite] Zotero-first: " + localResults.length + " local results, best score=" +
        bestLocalScore.toFixed(1) + ", sufficient=" + localIsSufficient);
    }

    if (localIsSufficient) {
      // Good local match found — skip external search (user's library has what they need)
      allResults = localResults;

      if (typeof Zotero !== "undefined") {
        Zotero.log("[InstantCite] Local results sufficient, skipping external search");
      }
    } else {
      // No good local match — search external sources
      if (localResults.length > 0) {
        allResults.push(...localResults);
      }
      const externalSearches = buildSearches(enabledSources, options, errors, true);
      if (externalSearches.length > 0) {
        const externalResults = await Promise.all(externalSearches.map(s => s.promise));
        collectResults(externalResults, externalSearches, allResults, sourceCounts);
      }
    }
  }

  // Deduplicate and rank
  const deduplicated = deduplicateResults(allResults);
  // Relevance ranks inside a tier; provenance decides the tiers themselves:
  // cited in the document → already in the library → fetched from the internet.
  const ranked = sortByProvenance(
    rankResults(deduplicated, effectiveQuery),
    options.prioritizedItemIds,
  );

  // Check if local results dominated — use unbiased score (without +50 Zotero boost)
  const topIsLocal = ranked.length > 0 && ranked[0].sources.includes("Zotero");
  const bestUnbiasedLocalScore = ranked
    .filter(p => p.sources.includes("Zotero"))
    .reduce((best, p) => {
      const unbiased = { ...p, sources: p.sources.filter(s => s !== "Zotero") };
      return Math.max(best, scoreRelevance(unbiased, effectiveQuery));
    }, 0);

  return {
    papers: ranked,
    totalCount: ranked.length,
    sourceCounts,
    searchTimeMs: Date.now() - start,
    errors,
    localSufficient: topIsLocal && bestUnbiasedLocalScore >= LOCAL_SUFFICIENT_SCORE,
    doiFallback,
  };
}

/**
 * Identifier lookups (DOI, PMID) query the local library first, then the
 * canonical external sources. Zotero comes first in the returned list so that
 * deduplication keeps the local record as the surviving one — it carries the
 * `_zoteroItemId` the document/library tiers are built on.
 */
function buildIdentifierSources(
  options: SearchOptions,
  externals: Array<{ source: string; run: () => Promise<SearchResponse> }>,
  localOptions: SearchOptions,
  errors: Array<{ source: string; error: string }>,
): Array<{ promise: Promise<SearchResponse | null>; source: string }> {
  const enabledSources = new Set(options.sources ?? ALL_SOURCES);
  const sources: Array<{ source: string; run: () => Promise<SearchResponse> }> = [];

  if (enabledSources.has("Zotero")) {
    sources.push({ source: "Zotero", run: () => searchZoteroLocal(localOptions) });
  }
  sources.push(...externals);

  return sources.map(({ source, run }) => ({
    source,
    promise: safeSearch(run, source, errors),
  }));
}

/** Build search promises for sources (optionally excluding Zotero) */
function buildSearches(
  enabledSources: Set<string>,
  options: SearchOptions,
  errors: Array<{ source: string; error: string }>,
  externalOnly = false,
): Array<{ promise: Promise<SearchResponse | null>; source: string }> {
  const searchMap: Record<string, () => Promise<SearchResponse>> = {
    Zotero: () => searchZoteroLocal(options),
    PubMed: () => searchPubMed(options),
    EuropePMC: () => searchEuropePMC(options),
    CrossRef: () => searchCrossRef(options),
    DOAJ: () => searchDOAJ(options),
    OpenLibrary: () => searchOpenLibrary(options),
    GoogleBooks: () => searchGoogleBooks(options),
    LoC: () => searchLoC(options),
    ECHR: () => searchECHR(options),
    "EUR-Lex": () => searchEurLex(options),
    CourtListener: () => searchCourtListener(options),
  };

  const sourcesToSearch = externalOnly ? EXTERNAL_SOURCES : ALL_SOURCES;
  const searches: Array<{ promise: Promise<SearchResponse | null>; source: string }> = [];

  for (const source of sourcesToSearch) {
    if (enabledSources.has(source) && searchMap[source]) {
      searches.push({
        promise: safeSearch(searchMap[source], source, errors),
        source,
      });
    }
  }

  return searches;
}

/** Collect results from parallel searches into the allResults array */
function collectResults(
  results: Array<SearchResponse | null>,
  searches: Array<{ source: string }>,
  allResults: PaperResult[],
  sourceCounts: Record<string, number>,
) {
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const source = searches[i].source;
    if (result) {
      allResults.push(...result.results);
      sourceCounts[source] = result.results.length;
    }
  }
}

async function safeSearch(
  fn: () => Promise<SearchResponse>,
  source: string,
  errors: Array<{ source: string; error: string }>,
): Promise<SearchResponse | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fn();
      if (typeof Zotero !== "undefined") {
        Zotero.log("[InstantCite] " + source + " returned " + result.results.length + " results");
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && message.includes("429")) {
        if (typeof Zotero !== "undefined") {
          Zotero.log("[InstantCite] " + source + " rate limited, retrying in 3s...");
        }
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      if (typeof Zotero !== "undefined") {
        Zotero.log("[InstantCite] " + source + " FAILED: " + message);
      }
      errors.push({ source, error: message });
      return null;
    }
  }
  return null;
}
