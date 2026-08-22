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
