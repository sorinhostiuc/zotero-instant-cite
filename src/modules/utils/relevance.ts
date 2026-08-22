import type { PaperResult } from "../api/types";
import { isLegislativeReference, parseLegislativeReference } from "./legislative-detector";
import { normalizeForSearch } from "./text-normalizer";

// Common English stop words — low informational value, should not drive scoring
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "not", "no", "nor",
  "so", "if", "then", "than", "that", "this", "these", "those", "it",
  "its", "as", "up", "out", "about", "into", "through", "during", "before",
  "after", "above", "below", "between", "under", "over", "again", "further",
  "each", "every", "all", "both", "few", "more", "most", "other", "some",
  "such", "only", "own", "same", "very", "just", "because", "also",
]);

/** Extract meaningful terms from a query, filtering out stop words */
function extractTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/** Strip URL prefix from a DOI-shaped query so callers can compare cleanly. */
function normalizeDOIQuery(query: string): string | null {
  const stripped = query.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return /^10\.\d{4,}\/\S+$/.test(stripped) ? stripped.toLowerCase() : null;
}

function detectLooseLegislativeQuery(query: string): { number: string; keyword: string } | null {
  const normalized = normalizeForSearch(query);
  if (!/\d/.test(normalized)) return null;

  const keywordMatch = normalized.match(
    /\b(legea?|law|act|statute|oug|og|hg|decret|ordin|cod(?:ul)?|regulation|directive|decision|public law|executive order)\b/,
  );
  if (!keywordMatch) return null;

  const numberMatch = normalized.match(/\b(\d{1,4}(?:[/-]\d{1,4})?)\b/);
  if (!numberMatch) return null;

  return { number: numberMatch[1], keyword: keywordMatch[1] };
}

function extractLegalCodeNumber(title: string): string | null {
  const match = isLegislativeReference(title);
  if (!match) return null;
  const parsed = parseLegislativeReference(title, match);
  return parsed.codeNumber || null;
}

export function scoreRelevance(paper: PaperResult, query: string): number {
  // Exact DOI match: when the user queries by DOI, the paper carrying that exact
  // DOI must always rank first. Without this guard, a DOI query reduces to a
  // keyword that appears in no titles, all papers tie on title hits = 0, and the
  // ranking falls through to citation count + recency — which can promote a
  // completely unrelated paper that shares the search topic.
  const doiQuery = normalizeDOIQuery(query);
  if (doiQuery && paper.doi && paper.doi.toLowerCase() === doiQuery) {
    return 1000;
  }

  const allTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const terms = extractTerms(query);
  // If after filtering we have no terms (all were stop words), fall back to all
  const scoringTerms = terms.length > 0 ? terms : allTerms;

  const title = paper.title.toLowerCase();
  const abstract = (paper.abstract ?? "").toLowerCase();
  const authorStr = paper.authors.map(a => a.name.toLowerCase()).join(" ");
  const paperLegal = isLegislativeReference(paper.title);
  const queryLegal = detectLooseLegislativeQuery(query);

  let score = 0;

  // ── 1. Title term matching (proportional) ──
  // The key insight: what matters is the PROPORTION of query terms found in the title
  let titleHits = 0;
  for (const term of scoringTerms) {
    if (title.includes(term)) titleHits++;
  }
  const titleProportion = scoringTerms.length > 0 ? titleHits / scoringTerms.length : 0;
  // Proportional score: 0-40 points. A paper matching all terms gets 40, half gets ~10
  // Using a power curve: proportion^1.5 rewards high coverage disproportionately
  score += Math.pow(titleProportion, 1.5) * 40;

  // ── 2. Exact phrase match bonus ──
  // If the entire query (or a large chunk) appears as a phrase in the title
  const queryNorm = query.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  if (queryNorm.length > 3 && title.includes(queryNorm)) {
    score += 30; // massive bonus for exact phrase match in title
  } else {
    // Check for partial phrase matches (consecutive words from query found in title)
    const queryWords = queryNorm.split(/\s+/);
    if (queryWords.length >= 3) {
      let maxConsecutive = 0;
      for (let i = 0; i <= queryWords.length - 2; i++) {
        for (let j = i + 2; j <= queryWords.length; j++) {
          const phrase = queryWords.slice(i, j).join(" ");
          if (title.includes(phrase) && (j - i) > maxConsecutive) {
            maxConsecutive = j - i;
          }
        }
      }
      if (maxConsecutive >= 2) {
        score += (maxConsecutive / queryWords.length) * 15;
      }
    }
  }

  // ── 3. Abstract term matching (proportional, lower weight) ──
  let abstractHits = 0;
  for (const term of scoringTerms) {
    if (abstract.includes(term)) abstractHits++;
  }
  const abstractProportion = scoringTerms.length > 0 ? abstractHits / scoringTerms.length : 0;
  score += Math.pow(abstractProportion, 1.5) * 15;

  // ── 4. Author match ──
  // If the query contains an author name, boost significantly
  for (const term of scoringTerms) {
    if (term.length >= 3 && authorStr.includes(term)) {
      score += 5;
    }
  }

  // ── 5. Zotero local library boost ──
  // Papers already in the user's library are highly relevant — user chose them before
  if (paper.sources.includes("Zotero")) {
    score += 50;
  }

  // ── 6. Citation count boost (logarithmic, capped) ──
  if (paper.citationCount && paper.citationCount > 0) {
    score += Math.min(Math.log10(paper.citationCount + 1) * 3, 12);
  }

  // ── 7. Recency boost (gentle) ──
  const currentYear = new Date().getFullYear();
  const age = currentYear - paper.year;
  if (age <= 1) score += 4;
  else if (age <= 3) score += 3;
  else if (age <= 5) score += 2;
  else if (age <= 10) score += 1;

  // ── 8. Open access boost (small) ──
  if (paper.isOpenAccess) score += 1;

  // ── 9. Multi-source boost (found in multiple databases) ──
  score += (paper.sources.length - 1) * 2;

  // ── 9b. Legislative query boost ──
  // Queries like "lege 95" or "oug 57" should strongly prefer the matching
  // statute even when the title phrasing differs across sources.
  if (queryLegal && paperLegal) {
    const paperCode = extractLegalCodeNumber(paper.title);
    const queryNumber = queryLegal.number;
    const paperCodeNorm = normalizeForSearch(paperCode ?? "");
    const queryNumberNorm = normalizeForSearch(queryNumber);

    if (paperCodeNorm && (paperCodeNorm === queryNumberNorm || paperCodeNorm.startsWith(queryNumberNorm + "/") || paperCodeNorm.startsWith(queryNumberNorm + "-"))) {
      score += 45;
    } else if (paperCodeNorm && paperCodeNorm.includes(queryNumberNorm)) {
      score += 25;
    } else if (paperLegal.subType && queryLegal.keyword.includes(paperLegal.subType)) {
      score += 10;
    } else {
      score -= 8;
    }
  } else if (queryLegal && !paperLegal) {
    // If the query is clearly legislative, non-legislative results are less
    // useful than a true statute match.
    score -= 5;
  }

  // ── 10. Penalty for papers with zero title hits ──
  // If the paper title doesn't contain ANY query term, it's likely noise
  if (titleHits === 0 && abstractHits === 0) {
    score -= 10;
  }

  return Math.max(0, score);
}

export function rankResults(papers: PaperResult[], query: string): PaperResult[] {
  return papers
    .map((p) => ({ ...p, relevanceScore: scoreRelevance(p, query) }))
    .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
}
