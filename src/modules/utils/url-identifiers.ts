import { isWellFormedDoi } from "./doi";

/** Identifiers a web link names on its own, without fetching the page. */
export interface UrlIdentifiers {
  doi?: string;
  pmid?: string;
  openalexId?: string;
}

// Publisher URLs often append a view name after the DOI
// (".../10.3389/fmed.2021.612345/full"); those segments are never part of it.
const VIEW_SUFFIX = /\/(?:full|abstract|pdf|epdf|pdfdirect|pdfft|html|fulltext|full-text|summary|meta|references|figures|tables|suppl|supplementary|info|metrics|citations|authors|reader|epub|issuetoc|toc)$/i;

function cleanDoiCandidate(raw: string): string {
  let doi = raw.replace(/[)\].,;:'"]+$/, "");
  let previous = "";
  while (previous !== doi) {
    previous = doi;
    doi = doi.replace(VIEW_SUFFIX, "").replace(/\.pdf$/i, "").replace(/\/+$/, "");
  }
  return doi;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Read a DOI, PMID or OpenAlex work ID straight from a link. A lookup by
 * identifier is exact and works on sites that refuse automated page requests,
 * so it is tried before the page itself is downloaded.
 */
export function identifiersFromURL(raw: string): UrlIdentifiers {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {};
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = safeDecode(url.pathname);

  if (host === "pubmed.ncbi.nlm.nih.gov") {
    const m = path.match(/^\/(\d{1,9})\/?$/);
    if (m) return { pmid: m[1] };
  }
  if (host === "ncbi.nlm.nih.gov") {
    const m = path.match(/^\/pubmed\/(\d{1,9})\/?$/);
    if (m) return { pmid: m[1] };
  }
  if (host === "openalex.org" || host === "api.openalex.org") {
    const m = path.match(/^\/(?:works\/)?(W\d{5,})\/?$/i);
    if (m) return { openalexId: m[1].toUpperCase() };
  }

  const candidates = [path, safeDecode(url.search)];
  for (const text of candidates) {
    const m = text.match(/10\.\d{4,9}\/[^\s?#&]+/);
    if (!m) continue;
    const doi = cleanDoiCandidate(m[0]);
    if (isWellFormedDoi(doi)) return { doi };
  }
  return {};
}

/**
 * The part of a link worth matching against stored Zotero URLs: scheme,
 * "www.", fragment and trailing slash vary between copies of the same link.
 */
export function urlMatchKey(raw: string): string {
  return raw.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
}
