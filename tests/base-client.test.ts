import { afterEach, describe, it, expect, vi } from "vitest";
import { fetchJSON } from "../src/modules/api/base-client";

describe("PaperResult type", () => {
  it("should represent a normalized paper result", () => {
    const paper: any = {
      title: "Test Paper",
      authors: [{ name: "Smith J" }],
      year: 2023,
      doi: "10.1234/test",
      sources: ["PubMed"],
    };
    expect(paper.title).toBe("Test Paper");
    expect(paper.sources).toContain("PubMed");
  });
});

describe("fetchJSON through Zotero.HTTP", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns off Zotero's automatic 429/5xx retries", async () => {
    // Left on, Zotero.HTTP.request keeps retrying a throttled source for up
    // to an hour and the search waits minutes for it.
    const request = vi.fn(async () => ({ status: 200, statusText: "OK", responseText: "{\"ok\":true}" }));
    vi.stubGlobal("Zotero", { HTTP: { request }, Prefs: { get: () => undefined }, log: () => {} });

    expect(await fetchJSON("https://example.org/x", 5000)).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("GET", "https://example.org/x", expect.objectContaining({
      timeout: 5000,
      errorDelayMax: 0,
      noRetryOnThrottle: true,
    }));
  });
});
