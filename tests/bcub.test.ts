import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import {
  buildDwrBody,
  decodeJsString,
  parseBcubRecord,
  parseBcubResults,
  parseCreators,
  parseDwrReplies,
  parseParentDescription,
  parseParentTitle,
  parsePublication,
  parseRecordUuids,
  parseTotalCount,
  recordUrl,
} from "../src/modules/api/bcub";
import hovers from "./fixtures/bcub-hovers.json";

const navigateList = readFileSync(join(__dirname, "fixtures", "bcub-navigate-list.txt"), "utf-8");
const hover = (uuid: string) => hovers.find(h => h.uuid === uuid)!.html;

describe("BCUB DWR plumbing", () => {
  it("reads the total from the navigation message", () => {
    expect(parseTotalCount('<span id="navigationMessage">1-10 din 43</span>')).toBe(43);
    expect(parseTotalCount("<p>Nu s-au găsit înregistrări</p>")).toBe(0);
  });

  it("decodes DWR string literals", () => {
    expect(decodeJsString('"a\\"b\\nc\\u0103\\x41\\/"')).toBe('a"b\ncăA/');
  });

  it("maps batched callbacks to their call ids", () => {
    const reply = [
      "//#DWR-INSERT",
      "//#DWR-REPLY",
      'dwr.engine.remote.handleCallback("0","1","<b>second<\\/b>");',
      'dwr.engine.remote.handleCallback("0","0","first");',
    ].join("\n");
    const replies = parseDwrReplies(reply);
    expect(replies.get(0)).toBe("first");
    expect(replies.get(1)).toBe("<b>second</b>");
  });

  it("extracts the first page of record ids in order", () => {
    const uuids = parseRecordUuids(navigateList);
    expect(uuids.length).toBe(10);
    expect(uuids[0]).toBe("d13c16bfc1e7090b5e63352b002533aa");
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  it("builds a batched plaincall body", () => {
    const body = buildDwrBody([
      ["OpacSearchResult", "getHoverDetail", ["boolean:false", "string:abc"]],
      ["OpacSearchResult", "getHoverDetail", ["boolean:false", "string:def"]],
    ], "SID/page");
    expect(body).toContain("callCount=2\n");
    expect(body).toContain("c1-param1=string:def\n");
    expect(body).toContain("scriptSessionId=SID/page\n");
  });

  it("links a record through a search on its id", () => {
    expect(recordUrl("29cdb0fbc1e7090b4cf8861c0013fc5e"))
      .toContain("queryTerm=uuid%3D%2229cdb0fbc1e7090b4cf8861c0013fc5e%22");
  });
});

describe("BCUB record parser", () => {
  it("maps a book with publisher, place, year and ISBN", () => {
    const r = parseBcubRecord("29cdb0fbc1e7090b4cf8861c0013fc5e", hover("29cdb0fbc1e7090b4cf8861c0013fc5e"))!;
    expect(r.itemType).toBe("book");
    expect(r.title).toBe("Raspunderea penala pentru malpraxis medical");
    expect(r.authors).toEqual([{ name: "Irina Kuglay", lastName: "Kuglay", firstName: "Irina" }]);
    expect(r.publisher).toBe("Editura C. H. Beck");
    expect(r.place).toBe("Bucuresti");
    expect(r.year).toBe(2021);
    expect(r.isbn).toBe("9786061811359");
    expect(r.sources).toEqual(["BCUB"]);
    expect(r.id).toBe("bcub:29cdb0fbc1e7090b4cf8861c0013fc5e");
  });

  it("maps an analytic article to its journal and issue", () => {
    const r = parseBcubRecord("d139caeec1e7090b6c0ecf5000249cce", hover("d139caeec1e7090b6c0ecf5000249cce"))!;
    expect(r.itemType).toBe("journalArticle");
    expect(r.title).toBe("Raspunderea civila a medicilor pentru malpraxis medical");
    expect(r.journal).toBe("Curierul judiciar");
    expect(r.issue).toBe("8");
    expect(r.year).toBe(2020);
    expect(r.authors[0]).toMatchObject({ lastName: "Preda", firstName: "Ana-Miruna" });
    expect(r.publisher).toBeUndefined();
  });

  it("keeps every author of a multi-author article", () => {
    const r = parseBcubRecord("e9dd782bc1e7090b68859003001755da", hover("e9dd782bc1e7090b68859003001755da"))!;
    expect(r.journal).toBe("Revista româna de drept al afacerilor");
    expect(r.authors.map(a => a.lastName)).toEqual(["Nemes", "Nemes"]);
    expect(r.authors.map(a => a.firstName)).toEqual(["Vasile", "Marinela"]);
  });

  it("maps a thesis and its adviser as contributor", () => {
    const r = parseBcubRecord("ddaf7dd6ac10030e2bcda8f800103c5d", hover("ddaf7dd6ac10030e2bcda8f800103c5d"))!;
    expect(r.itemType).toBe("thesis");
    expect(r.authors).toEqual([
      { name: "Radu Dumitrescu", lastName: "Dumitrescu", firstName: "Radu" },
      { name: "Maria Voinea", lastName: "Voinea", firstName: "Maria", creatorType: "contributor" },
    ]);
  });

  it("skips serial records", () => {
    expect(parseBcubRecord("070e5af5c1e7090b4898ef73002b8aeb", hover("070e5af5c1e7090b4898ef73002b8aeb"))).toBeNull();
  });

  it("filters by year but keeps undated records", () => {
    const results = parseBcubResults(hovers, { query: "x", yearFrom: 2015 });
    const ids = results.map(r => r.id);
    expect(ids).toContain("bcub:29cdb0fbc1e7090b4cf8861c0013fc5e");
    expect(ids).toContain("bcub:ddaf7dd6ac10030e2bcda8f800103c5d");
    expect(ids).not.toContain("bcub:e9dd782bc1e7090b68859003001755da");
  });
});

describe("BCUB field helpers", () => {
  it("assigns creator roles", () => {
    const authors = parseCreators(
      '<a href="#">Pop, Ion 1950-</a> [Editor]&nbsp; (3);&nbsp; <a href="#">Ionescu, Ana</a> [Traducător]',
      undefined,
      "book",
    );
    expect(authors).toEqual([
      { name: "Ion Pop", lastName: "Pop", firstName: "Ion", creatorType: "editor" },
      { name: "Ana Ionescu", lastName: "Ionescu", firstName: "Ana", creatorType: "translator" },
    ]);
  });

  it("falls back to a corporate author only without a person", () => {
    const corporate = '<a href="#">Academia Română</a> [Autor]';
    expect(parseCreators(undefined, corporate)).toEqual([
      { name: "Academia Română", lastName: "Academia Română", isCorporate: true },
    ]);
    expect(parseCreators('<a href="#">Pop, Ion</a> [Autor]', corporate).map(a => a.lastName)).toEqual(["Pop"]);
  });

  it("splits a publication statement", () => {
    expect(parsePublication("Iasi: Polirom (120), 2005")).toEqual({ place: "Iasi", publisher: "Polirom", year: 2005 });
    expect(parsePublication("[S.l.]: [s.n.], 1999").year).toBe(1999);
    expect(parsePublication(undefined)).toEqual({ year: 0 });
  });

  it("reads volume, issue, pages and year from the parent description", () => {
    expect(parseParentDescription("Vol. 3, nr. 4/2005, p. 12 - 20")).toEqual({ volume: "3", issue: "4", pages: "12-20", year: 2005 });
    expect(parseParentDescription("An 27, nr. 8/2016")).toMatchObject({ volume: "27", issue: "8", year: 2016 });
  });

  it("shortens the parent title and fixes the capitalised filing word", () => {
    expect(parseParentTitle("REVISTA romana de bioetica : Roumanian Journal of Bioethics")).toBe("Revista romana de bioetica");
    expect(parseParentTitle("Medicina legala")).toBe("Medicina legala");
  });
});
