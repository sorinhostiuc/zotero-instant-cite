export interface Author {
  name: string;
  // Structured name parts — populated by APIs that provide them (PubMed, Europe PMC,
  // CrossRef, local Zotero). When present, zotero-bridge bypasses parseAuthorName so
  // we never mis-split "Smith JA" as firstName=Smith, lastName=JA, or stick a bogus
  // comma into "Human Mortality Database".
  lastName?: string;
  firstName?: string;
  isCorporate?: boolean;   // true → single-field creator (fieldMode: 1)
  creatorType?: string;    // Zotero creator type; default "author"
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

  // Item read from a web page by Zotero's translators, in translator JSON.
  // When present the bridge saves this record as is, so fields PaperResult
  // has no slot for (website title, access date, language) survive.
  zoteroJSON?: Record<string, any>;
}

export interface SearchOptions {
  query: string;
  maxResults?: number;          // Default 20
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly?: boolean;
  sources?: string[];           // Which sources to search (default: all)
  prioritizedItemIds?: Set<number>; // Local Zotero item IDs to keep first
  fields?: AdvancedFields;      // Advanced search; `query` then holds only the free text
}

/** Document kinds the advanced search can restrict to */
export type AdvancedItemType = "article" | "book" | "chapter" | "thesis" | "legal";

/** Fielded constraints from the advanced search panel */
export interface AdvancedFields {
  text?: string;                // Free text alone (set by the orchestrator)
  title?: string;
  author?: string;
  identifier?: string;          // DOI, ISBN or OpenAlex work ID
  itemType?: AdvancedItemType;
}

export interface SearchResponse {
  source: string;
  results: PaperResult[];
  totalCount: number;
  searchTimeMs: number;
  /** A caveat shown next to the results, e.g. a record built from the link alone */
  notice?: string;
}

export type QueryType = "DOI" | "PMID" | "ISBN" | "OPENALEX_ID" | "URL" | "KEYWORD";
