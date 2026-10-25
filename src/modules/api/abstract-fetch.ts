import { fetchJSON, fetchXML } from "./base-client";
import { reconstructAbstract } from "./openalex";
import { getOpenAlexApiKey } from "../preferences";
import type { PaperResult } from "./types";

const PUBMED_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const OPENALEX_WORKS = "https://api.openalex.org/works";
const EUROPEPMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const CROSSREF_WORKS = "https://api.crossref.org/works";
const S2_PAPER = "https://api.semanticscholar.org/graph/v1/paper";
const MAILTO = "sorin.hostiuc@umfcd.ro";
const ABSTRACT_TIMEOUT_MS = 10000;

type Fetcher = (paper: PaperResult) => Promise<string | undefined>;

/** One lookup per paper id, so repeated clicks reuse the first answer. */
const cache = new Map<string, Promise<string | undefined>>();

/** True when the card has something an abstract can be looked up by. */
export function canFetchAbstract(paper: PaperResult): boolean {
  return Boolean(paper.abstract || paper.doi || paper.pmid || paper.openalexId);
}

/**
 * Abstract for a result, fetched only when the user asks for it. The record's
 * own abstract wins; otherwise the sources are tried one after another and the
 * first non-empty answer is kept on the paper, so saving it carries the text.
 */
export function fetchAbstract(paper: PaperResult): Promise<string | undefined> {
  if (paper.abstract?.trim()) return Promise.resolve(paper.abstract.trim());
  const cached = cache.get(paper.id);
  if (cached) return cached;
  const pending = lookupAbstract(paper).then(text => {
    if (text) paper.abstract = text;
    else cache.delete(paper.id); // a later click may find it once a source recovers
    return text;
  });
  cache.set(paper.id, pending);
  return pending;
}

export function clearAbstractCache(): void {
  cache.clear();
}

async function lookupAbstract(paper: PaperResult): Promise<string | undefined> {
  const fetchers: Fetcher[] = [fromPubMed, fromOpenAlex, fromEuropePMC, fromCrossRef, fromSemanticScholar];
  for (const fetcher of fetchers) {
    try {
      const text = cleanAbstract(await fetcher(paper));
      if (text) return text;
    } catch (e) {
      if (typeof Zotero !== "undefined") Zotero.log("[InstantCite] Abstract lookup failed: " + e);
    }
  }
  return undefined;
}

async function fromPubMed(paper: PaperResult): Promise<string | undefined> {
  if (!paper.pmid) return undefined;
  const url = `${PUBMED_EFETCH}?db=pubmed&id=${encodeURIComponent(paper.pmid)}&rettype=abstract&retmode=xml`;
  const xml = await fetchXML(url, ABSTRACT_TIMEOUT_MS);
  let text = "";
  for (const part of Array.from(xml.querySelectorAll("Abstract AbstractText"))) {
    const label = part.getAttribute("Label");
    text += (label ? `${label}: ` : "") + (part.textContent ?? "") + " ";
  }
  return text;
}

async function fromOpenAlex(paper: PaperResult): Promise<string | undefined> {
  const id = paper.openalexId?.replace(/^https?:\/\/openalex\.org\//i, "")
    || (paper.doi ? `doi:${doiPath(paper.doi)}` : "");
  if (!id) return undefined;
  const params = new URLSearchParams({ select: "abstract_inverted_index" });
  const key = getOpenAlexApiKey();
  if (key) params.set("api_key", key);
  const work = await fetchJSON<any>(`${OPENALEX_WORKS}/${id}?${params}`, ABSTRACT_TIMEOUT_MS);
  return work?.abstract_inverted_index ? reconstructAbstract(work.abstract_inverted_index) : undefined;
}

async function fromEuropePMC(paper: PaperResult): Promise<string | undefined> {
  const query = paper.doi ? `DOI:"${paper.doi}"` : paper.pmid ? `EXT_ID:${paper.pmid} AND SRC:MED` : "";
  if (!query) return undefined;
  const params = new URLSearchParams({ query, resultType: "core", format: "json", pageSize: "1" });
  const data = await fetchJSON<any>(`${EUROPEPMC_SEARCH}?${params}`, ABSTRACT_TIMEOUT_MS);
  return data?.resultList?.result?.[0]?.abstractText;
}

async function fromCrossRef(paper: PaperResult): Promise<string | undefined> {
  if (!paper.doi) return undefined;
  const url = `${CROSSREF_WORKS}/${doiPath(paper.doi)}?mailto=${encodeURIComponent(MAILTO)}`;
  const data = await fetchJSON<any>(url, ABSTRACT_TIMEOUT_MS);
  // JATS abstracts often open with a bare "Abstract" heading
  return data?.message?.abstract?.replace(/<jats:title>\s*Abstract\s*<\/jats:title>/i, "");
}

async function fromSemanticScholar(paper: PaperResult): Promise<string | undefined> {
  if (!paper.doi) return undefined;
  const url = `${S2_PAPER}/DOI:${doiPath(paper.doi)}?fields=abstract`;
  const data = await fetchJSON<any>(url, ABSTRACT_TIMEOUT_MS);
  return data?.abstract ?? undefined;
}

/** DOI as a URL path: each segment escaped, the slashes kept. */
function doiPath(doi: string): string {
  return doi.split("/").map(encodeURIComponent).join("/");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/** Plain text from the markup the sources wrap abstracts in (JATS, HTML). */
export function cleanAbstract(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .replace(/<\/(?:p|jats:p|h\d|jats:title|jats:sec|div)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim()
    // OpenAlex and some publishers keep the heading as the first word
    .replace(/^abstract\b[\s:.]*/i, "");
}
