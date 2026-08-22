import { describe, it, expect } from "vitest";
import { parseAuthorName } from "../src/modules/zotero-bridge";

describe("parseAuthorName", () => {
  it("should parse 'Smith J' as lastName='Smith', firstName='J'", () => {
    expect(parseAuthorName("Smith J")).toEqual({ lastName: "Smith", firstName: "J" });
  });

  it("should parse 'Van der Berg A' as lastName='Van der Berg', firstName='A'", () => {
    expect(parseAuthorName("Van der Berg A")).toEqual({ lastName: "Van der Berg", firstName: "A" });
  });

  it("should handle single name", () => {
    expect(parseAuthorName("Madonna")).toEqual({ lastName: "Madonna", firstName: "" });
  });

  it("should handle 'Smith JA' (double initials)", () => {
    expect(parseAuthorName("Smith JA")).toEqual({ lastName: "Smith", firstName: "JA" });
  });
});
