import type { QueryType } from "../api/types";

interface QueryDetection {
  type: QueryType;
  value: string;
}

export function detectQueryType(raw: string): QueryDetection {
  const query = raw.trim();

  // DOI: strip URL prefix, then match 10.xxxx/xxxxx
  const doiStripped = query.replace(/^https?:\/\/doi\.org\//, "");
  if (/^10\.\d{4,}\/\S+$/.test(doiStripped)) {
    return { type: "DOI", value: doiStripped };
  }

  // Web link: the page is read for its identifiers or translated by Zotero.
  // Checked after the DOI so doi.org links keep the direct DOI lookup.
  if (/^(?:https?:\/\/|www\.)[^\s]+$/i.test(query)) {
    return { type: "URL", value: /^www\./i.test(query) ? "https://" + query : query };
  }

  // ISBN-10/13, with or without hyphens and an "ISBN" label. The checksum
  // keeps other 10/13 digit numbers (phone numbers, case numbers) out.
  const isbn = normalizeISBN(query);
  if (isbn) {
    return { type: "ISBN", value: isbn };
  }

  // PMID: 6-9 digit number (real PMIDs are currently 6-8 digits)
  if (/^\d{6,9}$/.test(query)) {
    return { type: "PMID", value: query };
  }

  // OpenAlex ID: W followed by digits
  if (/^W\d{5,}$/i.test(query)) {
    return { type: "OPENALEX_ID", value: query };
  }

  return { type: "KEYWORD", value: query };
}

/** Return the bare ISBN (digits, trailing X) when `raw` is a valid ISBN-10 or ISBN-13. */
export function normalizeISBN(raw: string): string | null {
  const stripped = raw.trim().replace(/^isbn(?:-1[03])?:?\s*/i, "");
  if (!/^[\d\s-]+[\dXx]$/.test(stripped)) return null;
  const isbn = stripped.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const d = isbn[i] === "X" ? 10 : Number(isbn[i]);
      sum += d * (10 - i);
    }
    return sum % 11 === 0 ? isbn : null;
  }
  if (/^97[89]\d{10}$/.test(isbn)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    return sum % 10 === 0 ? isbn : null;
  }
  return null;
}
