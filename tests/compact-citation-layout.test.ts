import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "addon/chrome/content/instantcite.css"), "utf8");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match![1];
}

describe("compact citation layout", () => {
  it("keeps selected citation details to a two-row default height", () => {
    expect(cssRule(".citation-details-panel")).toContain("max-height: 96px;");
    expect(cssRule(".citation-detail-row")).toContain("padding: 2px 0;");
    expect(cssRule(".citation-detail-title")).toContain("font-size: 10px;");
    expect(cssRule(".citation-detail-input")).toContain("font-size: 10px;");
  });

  it("renders existing citation cards as dense two-line rows by default", () => {
    const cardRule = cssRule(".existing-item-card");

    expect(cardRule).toContain("max-height: 42px;");
    expect(cardRule).toContain("overflow: hidden;");
    expect(cardRule).toContain("padding: 4px 6px;");
    expect(cssRule(".existing-item-card .result-title")).toContain("white-space: nowrap;");
  });

  it("uses the blue compact theme instead of the old red and orange palette", () => {
    expect(css).toContain("#087ea4");
    expect(css).toContain("#f7fcff");

    for (const oldColor of [
      "#900",
      "#c00",
      "#fdf6f0",
      "#e8d5c4",
      "#8b4513",
      "#d4a574",
      "#fff9f4",
      "#fff4eb",
      "#fff5f5",
      "#fff3e0",
      "#f57c00",
      "#fce4ec",
      "#c62828",
      "rgba(153, 0, 0",
    ]) {
      expect(css).not.toContain(oldColor);
    }
  });
});
