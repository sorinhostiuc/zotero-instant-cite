import { fetchJSON, fetchXML } from "./base-client";
import type { PaperResult, SearchOptions, SearchResponse, Author } from "./types";

const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

export async function searchPubMed(options: SearchOptions): Promise<SearchResponse> {
  const start = Date.now();
  const maxResults = Math.min(options.maxResults ?? 20, 100); // PubMed efetch gets slow with large XML

  // Step 1: ESearch to get PMIDs.
  // For DOI queries, anchor with the [doi] field tag — without it, esearch
  // does broad match and returns articles that share topical words with the DOI's
  // subject area instead of the article that actually carries that DOI.
  const trimmed = options.query.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const isDOI = /^10\.\d{4,}\/\S+$/.test(trimmed);
  let term = isDOI ? `${trimmed}[doi]` : options.query;
  if (options.yearFrom || options.yearTo) {
    const from = options.yearFrom ?? 1900;
    const to = options.yearTo ?? new Date().getFullYear();
    term += ` AND ${from}:${to}[dp]`;
  }

  const searchUrl = `${ESEARCH_URL}?db=pubmed&term=${encodeURIComponent(term)}&retmax=${maxResults}&retmode=json`;
  const searchData = await fetchJSON<any>(searchUrl);
  const pmids: string[] = searchData?.esearchresult?.idlist ?? [];
  const totalCount = parseInt(searchData?.esearchresult?.count ?? "0", 10);

  if (pmids.length === 0) {
    return { source: "PubMed", results: [], totalCount: 0, searchTimeMs: Date.now() - start };
  }

  // Step 2: EFetch to get full metadata (batched)
  const fetchUrl = `${EFETCH_URL}?db=pubmed&id=${pmids.join(",")}&rettype=xml&retmode=xml`;
  const xmlDoc = await fetchXML(fetchUrl);
  const results = parsePubMedXMLDoc(xmlDoc);

  return {
    source: "PubMed",
    results,
    totalCount,
    searchTimeMs: Date.now() - start,
  };
}

/** Parse from XML string (for testing) */
export function parsePubMedArticles(xmlString: string): PaperResult[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");
  return parsePubMedXMLDoc(doc);
}

/** Parse from XML Document */
function parsePubMedXMLDoc(doc: Document): PaperResult[] {
  const articles = doc.querySelectorAll("PubmedArticle");
  const results: PaperResult[] = [];

  for (const article of articles) {
    const pmid = article.querySelector("PMID")?.textContent ?? "";
    const title = article.querySelector("ArticleTitle")?.textContent ?? "";

    // Authors (including corporate/collaborative group names)
    const authorNodes = article.querySelectorAll("AuthorList Author");
    const authors: Author[] = [];
    for (const an of authorNodes) {
      const collectiveName = an.querySelector("CollectiveName")?.textContent;
      if (collectiveName) {
        authors.push({ name: collectiveName, lastName: collectiveName, isCorporate: true });
        continue;
      }
      const lastName = an.querySelector("LastName")?.textContent ?? "";
      const initials = an.querySelector("Initials")?.textContent ?? "";
      const affNode = an.querySelector("AffiliationInfo Affiliation");
      const name = `${lastName} ${initials}`.trim();
      if (name) {
        authors.push({
          name,
          lastName,
          firstName: initials,
          affiliation: affNode?.textContent ?? undefined,
        });
      }
    }

    // Year
    const yearStr =
      article.querySelector("PubDate Year")?.textContent ??
      article.querySelector("PubDate MedlineDate")?.textContent?.slice(0, 4) ??
      "0";
    const year = parseInt(yearStr, 10);

    // Journal
    const journal = article.querySelector("Journal Title")?.textContent ??
      article.querySelector("ISOAbbreviation")?.textContent ?? "";
    const journalAbbreviation = article.querySelector("ISOAbbreviation")?.textContent ?? undefined;
    const issn = article.querySelector("Journal ISSN")?.textContent ?? undefined;

    // Volume, issue, pages
    const journalIssue = article.querySelector("JournalIssue");
    const volume = journalIssue?.getAttribute("Volume") ?? undefined;
    const issue = journalIssue?.getAttribute("Issue") ?? undefined;
    const pages = article.querySelector("Pagination MedlinePgn")?.textContent ?? undefined;

    // DOI
    const idNodes = article.querySelectorAll("ArticleIdList ArticleId");
    let doi: string | undefined;
    for (const idNode of idNodes) {
      if (idNode.getAttribute("IdType") === "doi") {
        doi = idNode.textContent ?? undefined;
      }
    }

    // Abstract
    const abstractParts = article.querySelectorAll("Abstract AbstractText");
    let abstract = "";
    for (const part of abstractParts) {
      const label = part.getAttribute("Label");
      if (label) abstract += `${label}: `;
      abstract += (part.textContent ?? "") + " ";
    }
    abstract = abstract.trim();

    results.push({
      id: `pubmed:${pmid}`,
      title,
      authors,
      year,
      journal,
      journalAbbreviation,
      issn,
      volume,
      issue,
      pages,
      doi,
      pmid,
      abstract: abstract || undefined,
      isOpenAccess: false, // PubMed doesn't directly provide OA status
      sources: ["PubMed"],
    });
  }

  return results;
}
