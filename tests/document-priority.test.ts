import { describe, expect, it } from "vitest";
import {
  extractCitationItemIds,
  extractDocumentItemIds,
  sortByProvenance,
  sortItemIdsByDocumentPriority,
} from "../src/modules/utils/document-priority";
import type { PaperResult } from "../src/modules/api/types";

const paper = (id: string, zoteroItemId?: number): PaperResult => ({
  id,
  title: id,
  authors: [],
  year: 2024,
  isOpenAccess: false,
  sources: ["Zotero"],
  ...(zoteroItemId ? { _zoteroItemId: zoteroItemId } : {}),
} as PaperResult);

const external = (id: string, source = "CrossRef"): PaperResult => ({
  id,
  title: id,
  authors: [],
  year: 2024,
  isOpenAccess: false,
  sources: [source],
} as PaperResult);

describe("document priority", () => {
  it("keeps document items first without changing order inside each group", () => {
    const sorted = sortByProvenance(
      [paper("a", 1), paper("b", 2), paper("c", 3), paper("d", 4)],
      new Set([3, 1]),
    );

    expect(sorted.map(p => p.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("orders document, then library, then internet", () => {
    const sorted = sortByProvenance(
      [external("web1"), paper("lib", 2), external("web2"), paper("doc", 1)],
      new Set([1]),
    );

    expect(sorted.map(p => p.id)).toEqual(["doc", "lib", "web1", "web2"]);
  });

  it("puts library results above internet results even with no document", () => {
    const sorted = sortByProvenance([external("web"), paper("lib", 7)]);
    expect(sorted.map(p => p.id)).toEqual(["lib", "web"]);
  });

  it("treats a result merged with a local record as a library result", () => {
    const merged = { ...external("merged"), sources: ["CrossRef", "Zotero"] } as PaperResult;
    const sorted = sortByProvenance([external("web"), merged]);
    expect(sorted.map(p => p.id)).toEqual(["merged", "web"]);
  });

  it("preserves relevance order inside a tier", () => {
    const sorted = sortByProvenance([external("first"), external("second"), external("third")]);
    expect(sorted.map(p => p.id)).toEqual(["first", "second", "third"]);
  });

  it("prioritizes document item IDs before local result limiting", () => {
    const sorted = sortItemIdsByDocumentPriority([4, 3, 2, 1], new Set([1, 3]));
    expect(sorted).toEqual([3, 1, 4, 2]);
  });

  it("extracts cited item IDs from Zotero citation maps and citation items", () => {
    expect([...extractDocumentItemIds({ "12": [{}], abc: [{}], "15": [] })]).toEqual([12, 15]);
    expect([...extractDocumentItemIds(new Map<any, unknown>([[21, []], ["22", []]]))]).toEqual([21, 22]);
    expect([...extractCitationItemIds([{ id: 7 }, { itemID: "8" }, { id: "x" }])]).toEqual([7, 8]);
  });
});
