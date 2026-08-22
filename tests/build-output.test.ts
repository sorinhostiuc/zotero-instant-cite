import { describe, expect, it } from "vitest";
import { getRootXpiDestinations } from "../zotero-plugin.config";

describe("build output", () => {
  it("publishes generic and versioned XPIs in the project root", () => {
    expect(getRootXpiDestinations("0.6.9")).toEqual([
      "zotero-instant-cite.xpi",
      "zotero-instant-cite-0.6.9.xpi",
    ]);
  });
});
