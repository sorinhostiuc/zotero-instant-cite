export interface Author {
  name: string;
  // Structured name parts — populated by APIs that provide them (PubMed, Europe PMC,
  // CrossRef, local Zotero). When present, zotero-bridge bypasses parseAuthorName so
  // we never mis-split "Smith JA" as firstName=Smith, lastName=JA, or stick a bogus
  // comma into "Human Mortality Database".
  lastName?: string;
  firstName?: string;
  isCorporate?: boolean;   // true → single-field creator (fieldMode: 1)
  orcid?: string;
  affiliation?: string;
}

export interface PaperResult {
  id: string;                   // Internal unique ID (source:sourceId)
  title: string;
  authors: Author[];
  year: number;
  journal?: string;
  journalAbbreviation?: string;
  issn?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;           // Book publisher
  place?: string;               // Publication place (city)
  doi?: string;
  pmid?: string;
  openalexId?: string;
  isbn?: string;
  abstract?: string;
  citationCount?: number;
  isOpenAccess: boolean;
  pdfUrl?: string;
  sources: string[];            // Which APIs returned this paper
  relevanceScore?: number;

  // Legal document fields (optional)
  itemType?: string;            // Zotero item type override: "case", "statute", etc.
  caseNumber?: string;          // Application/case number (ECHR, CJEU)
  court?: string;               // Court name
  celex?: string;               // CELEX number (EUR-Lex)
  ecli?: string;                // European Case Law Identifier
  url?: string;                 // Direct URL to the document
}

export interface SearchOptions {
  query: string;
  maxResults?: number;          // Default 20
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly?: boolean;
  sources?: string[];           // Which sources to search (default: all)
  prioritizedItemIds?: Set<number>; // Local Zotero item IDs to keep first
}

export interface SearchResponse {
  source: string;
  results: PaperResult[];
  totalCount: number;
  searchTimeMs: number;
}

export type QueryType = "DOI" | "PMID" | "OPENALEX_ID" | "KEYWORD";
