import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/api/crossref", () => ({
  DOI_BATCH_SIZE: 50,
  lookupCrossRefDOI: vi.fn(),
  lookupCrossRefDOIBatch: vi.fn(),
  searchCrossRef: vi.fn(),
}));
vi.mock("../src/modules/api/europepmc", () => ({
  searchEuropePMC: vi.fn(),
}));
vi.mock("../src/modules/zotero-bridge", () => ({
  addToZotero: vi.fn(),
}));

import { addToZotero } from "../src/modules/zotero-bridge";
import {
  applyDoiFixPlan,
  bestTitleMatch,
  classifyDoiCheck,
  planDoiFix,
  readItemDoi,
  REVIEW_TAG,
} from "../src/modules/doi-fixer";
import type { PaperResult } from "../src/modules/api/types";

function paper(overrides: Partial<PaperResult> = {}): PaperResult {
  return {
    id: "test",
    title: "A study of something",
    authors: [],
    year: 2020,
    isOpenAccess: false,
    sources: ["CrossRef"],
    ...overrides,
  } as PaperResult;
}

describe("classifyDoiCheck", () => {
  it("accepts a DOI whose record matches the item title", () => {
    expect(
      classifyDoiCheck("Ethics of organ donation", "10.3390/medicina62020293", { title: "Ethics of organ donation" }),
    ).toBe("ok");
  });

  it("tolerates subtitle and punctuation differences", () => {
    expect(
      classifyDoiCheck(
        "Ethics of organ donation: a review",
        "10.3390/medicina62020293",
        { title: "Ethics of organ donation" },
      ),
    ).toBe("ok");
  });

  it("flags a DOI that resolves to a different article", () => {
    expect(
      classifyDoiCheck(
        "Ethics of organ donation in Romania",
        "10.1016/j.jflm.2019.05.001",
        { title: "Machine learning for protein folding prediction" },
      ),
    ).toBe("mismatch");
  });

  it("classifies a truncated reference-list DOI without any lookup", () => {
    expect(classifyDoiCheck("Ethics of organ donation", "10.1016/j.pec.2021.", null)).toBe("malformed");
    // Even a resolved record cannot rescue a fragment.
    expect(classifyDoiCheck("Ethics of organ donation", "10.1016/", { title: "Whatever" })).toBe("malformed");
  });

  it("treats a failed lookup as dead, never as a mismatch", () => {
    expect(classifyDoiCheck("Ethics of organ donation", "10.3390/medicina62020293", null)).toBe("dead");
  });

  it("passes an item with no title — there is nothing to contradict", () => {
    expect(classifyDoiCheck("", "10.3390/medicina62020293", { title: "Anything at all" })).toBe("ok");
  });
});

describe("planDoiFix", () => {
  const resolved = paper({ title: "Machine learning for protein folding", doi: "10.1016/wrong.2019" });

  it("plans nothing for a healthy DOI", () => {
    expect(planDoiFix({ verdict: "ok", oldDoi: "10.1/a", resolved, titleMatch: null })).toBeNull();
  });

  it("plans nothing for a dead DOI — an unreachable API is not a defect", () => {
    expect(planDoiFix({ verdict: "dead", oldDoi: "10.1/a", resolved: null, titleMatch: null })).toBeNull();
  });

  it("repairs a mismatch when the title search finds the real article", () => {
    const plan = planDoiFix({
      verdict: "mismatch",
      oldDoi: "10.1016/wrong.2019",
      resolved,
      titleMatch: paper({ title: "Ethics of organ donation", doi: "10.3390/right.2020" }),
    });

    expect(plan).toMatchObject({
      kind: "repair",
      oldDoi: "10.1016/wrong.2019",
      newDoi: "10.3390/right.2020",
      clearDoi: false,
      tags: [],
    });
    expect(plan!.extraLine).toBe("Wrong DOI: 10.1016/wrong.2019");
    // The article the bad DOI pointed to is what gets recovered.
    expect(plan!.recoverFrom).toBe(resolved);
  });

  it("clears the DOI and tags the item when the real article cannot be found", () => {
    const plan = planDoiFix({
      verdict: "mismatch",
      oldDoi: "10.1016/wrong.2019",
      resolved,
      titleMatch: null,
    });

    expect(plan).toMatchObject({
      kind: "orphan",
      newDoi: null,
      clearDoi: true,
      tags: [REVIEW_TAG],
    });
    expect(plan!.recoverFrom).toBe(resolved);
  });

  it("recovers nothing from a malformed DOI — it never resolved to an article", () => {
    const plan = planDoiFix({
      verdict: "malformed",
      oldDoi: "10.1016/j.pec.2021.",
      resolved: null,
      titleMatch: paper({ title: "Ethics of organ donation", doi: "10.3390/right.2020" }),
    });

    expect(plan!.kind).toBe("repair");
    expect(plan!.newDoi).toBe("10.3390/right.2020");
    expect(plan!.recoverFrom).toBeNull();
  });

  it("leaves the item alone when the title search lands back on the same DOI", () => {
    // The two sources contradict each other; the title comparison is the weaker
    // signal, so nothing is written.
    const plan = planDoiFix({
      verdict: "mismatch",
      oldDoi: "10.3390/right.2020",
      resolved,
      titleMatch: paper({ doi: "https://doi.org/10.3390/RIGHT.2020" }),
    });
    expect(plan).toBeNull();
  });
});

describe("bestTitleMatch", () => {
  it("ignores candidates without a DOI — they cannot repair anything", () => {
    const match = bestTitleMatch("Ethics of organ donation in Romania", [
      paper({ title: "Ethics of organ donation in Romania", doi: undefined }),
    ]);
    expect(match).toBeNull();
  });

  it("rejects loose matches below the strict search threshold", () => {
    const match = bestTitleMatch("Ethics of organ donation in Romania", [
      paper({ title: "Ethics of clinical trials in Germany", doi: "10.1/x" }),
    ]);
    expect(match).toBeNull();
  });

  it("returns the closest candidate above the threshold", () => {
    const match = bestTitleMatch("Ethics of organ donation in Romania", [
      paper({ title: "Ethics of clinical trials in Germany", doi: "10.1/x" }),
      paper({ title: "Ethics of organ donation in Romania", doi: "10.2/y" }),
    ]);
    expect(match?.doi).toBe("10.2/y");
  });
});

// ---------------------------------------------------------------------------

type FieldMap = Record<string, string>;

function createItem(fields: FieldMap = {}, collections: number[] = []) {
  const saved: FieldMap = { ...fields };
  const item: any = {
    id: 42,
    getField: vi.fn((f: string) => saved[f] ?? ""),
    setField: vi.fn((f: string, v: string) => { saved[f] = v; }),
    addTag: vi.fn(),
    getCollections: vi.fn(() => collections),
    saveTx: vi.fn(async () => undefined),
    _saved: saved,
  };
  return item;
}

function installZoteroMock(existingByDoi: Record<string, any> = {}) {
  const searchIds: number[] = [];
  (globalThis as any).Zotero = {
    log: vi.fn(),
    Libraries: { userLibraryID: 1 },
    Items: { get: vi.fn(() => null) },
    Search: class {
      libraryID = 1;
      private doi = "";
      addCondition(field: string, _op: string, value: string) {
        if (field === "DOI") this.doi = value;
      }
      async search() {
        const hit = existingByDoi[this.doi];
        return hit ? [hit.id] : searchIds;
      }
    },
  };
  (globalThis as any).Zotero.Items.get = vi.fn((id: number) => {
    for (const hit of Object.values(existingByDoi)) {
      if ((hit as any).id === id) return hit;
    }
    return null;
  });
}

describe("readItemDoi", () => {
  beforeEach(() => installZoteroMock());

  it("prefers the native DOI field", () => {
    const item = createItem({ DOI: "https://doi.org/10.1/a", extra: "DOI: 10.2/b" });
    expect(readItemDoi(item)).toEqual({ doi: "10.1/a", inExtra: false });
  });

  it("falls back to the DOI line in Extra for types without the field", () => {
    const item = createItem({ extra: "PMID: 12345\nDOI: 10.2/b" });
    expect(readItemDoi(item)).toEqual({ doi: "10.2/b", inExtra: true });
  });

  it("reports no DOI when neither carries one", () => {
    expect(readItemDoi(createItem({ extra: "PMID: 12345" })).doi).toBe("");
  });
});

describe("applyDoiFixPlan", () => {
  beforeEach(() => {
    vi.mocked(addToZotero).mockReset();
    installZoteroMock();
  });

  const recovered = paper({ title: "Machine learning for protein folding", doi: "10.1016/wrong.2019" });

  it("corrects the DOI on the existing item, keeping its key", async () => {
    const item = createItem({ DOI: "10.1016/wrong.2019", title: "Ethics of organ donation", extra: "" });
    vi.mocked(addToZotero).mockResolvedValue(createItem() as any);

    const outcome = await applyDoiFixPlan(item, {
      kind: "repair",
      oldDoi: "10.1016/wrong.2019",
      newDoi: "10.3390/right.2020",
      clearDoi: false,
      extraLine: "Wrong DOI: 10.1016/wrong.2019",
      tags: [],
      recoverFrom: recovered,
    });

    expect(item._saved.DOI).toBe("10.3390/right.2020");
    expect(item._saved.extra).toBe("Wrong DOI: 10.1016/wrong.2019");
    expect(outcome.repaired).toBe("doi-corrected");
    expect(outcome.createdTitle).toBe("Machine learning for protein folding");
  });

  it("saves the source item before creating the recovered reference", async () => {
    // Load-bearing order: addToZotero deduplicates by DOI, so recovering first
    // would match the source item on the DOI we are moving away from.
    const order: string[] = [];
    const item = createItem({ DOI: "10.1016/wrong.2019", title: "Ethics of organ donation" });
    item.saveTx = vi.fn(async () => { order.push("saveTx"); });
    vi.mocked(addToZotero).mockImplementation(async () => {
      order.push("addToZotero");
      return createItem() as any;
    });

    await applyDoiFixPlan(item, {
      kind: "repair",
      oldDoi: "10.1016/wrong.2019",
      newDoi: "10.3390/right.2020",
      clearDoi: false,
      extraLine: "Wrong DOI: 10.1016/wrong.2019",
      tags: [],
      recoverFrom: recovered,
    });

    expect(order).toEqual(["saveTx", "addToZotero"]);
  });

  it("clears the DOI and tags the item for an orphan plan", async () => {
    const item = createItem({ DOI: "10.1016/wrong.2019", title: "Ethics of organ donation" });
    vi.mocked(addToZotero).mockResolvedValue(createItem() as any);

    const outcome = await applyDoiFixPlan(item, {
      kind: "orphan",
      oldDoi: "10.1016/wrong.2019",
      newDoi: null,
      clearDoi: true,
      extraLine: "Wrong DOI: 10.1016/wrong.2019",
      tags: [REVIEW_TAG],
      recoverFrom: recovered,
    });

    expect(item._saved.DOI).toBe("");
    expect(item.addTag).toHaveBeenCalledWith(REVIEW_TAG);
    expect(outcome.repaired).toBe("doi-cleared");
  });

  it("creates nothing when the plan has no article to recover", async () => {
    const item = createItem({ DOI: "10.1016/j.pec.2021.", title: "Ethics of organ donation" });

    const outcome = await applyDoiFixPlan(item, {
      kind: "repair",
      oldDoi: "10.1016/j.pec.2021.",
      newDoi: "10.3390/right.2020",
      clearDoi: false,
      extraLine: "Wrong DOI: 10.1016/j.pec.2021.",
      tags: [],
      recoverFrom: null,
    });

    expect(addToZotero).not.toHaveBeenCalled();
    expect(outcome.createdTitle).toBeNull();
  });

  it("does not duplicate an article already in the library", async () => {
    const existing = createItem({ title: "Machine learning for protein folding", DOI: "10.1016/wrong.2019" });
    existing.id = 99;
    installZoteroMock({ "10.1016/wrong.2019": existing });

    const item = createItem({ DOI: "10.1016/wrong.2019", title: "Ethics of organ donation" });
    const outcome = await applyDoiFixPlan(item, {
      kind: "repair",
      oldDoi: "10.1016/wrong.2019",
      newDoi: "10.3390/right.2020",
      clearDoi: false,
      extraLine: "Wrong DOI: 10.1016/wrong.2019",
      tags: [],
      recoverFrom: recovered,
    });

    expect(addToZotero).not.toHaveBeenCalled();
    expect(outcome.alreadyPresent).toBe(true);
  });

  it("files the recovered reference in the source item's collections", async () => {
    const created = createItem();
    const item = createItem({ DOI: "10.1016/wrong.2019", title: "Ethics of organ donation" }, [7, 9]);
    vi.mocked(addToZotero).mockResolvedValue(created as any);
    created.addToCollection = vi.fn();

    await applyDoiFixPlan(item, {
      kind: "repair",
      oldDoi: "10.1016/wrong.2019",
      newDoi: "10.3390/right.2020",
      clearDoi: false,
      extraLine: "Wrong DOI: 10.1016/wrong.2019",
      tags: [],
      recoverFrom: recovered,
    });

    expect(created.addToCollection).toHaveBeenCalledWith(7);
    expect(created.addToCollection).toHaveBeenCalledWith(9);
    expect(created.saveTx).toHaveBeenCalled();
  });

  it("keeps the committed DOI repair when recovery fails", async () => {
    const item = createItem({ DOI: "10.1016/wrong.2019", title: "Ethics of organ donation" });
    vi.mocked(addToZotero).mockRejectedValue(new Error("network down"));

    const outcome = await applyDoiFixPlan(item, {
      kind: "repair",
      oldDoi: "10.1016/wrong.2019",
      newDoi: "10.3390/right.2020",
      clearDoi: false,
      extraLine: "Wrong DOI: 10.1016/wrong.2019",
      tags: [],
      recoverFrom: recovered,
    });

    expect(item._saved.DOI).toBe("10.3390/right.2020");
    expect(outcome.error).toContain("network down");
  });
});
