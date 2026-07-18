import { describe, expect, it } from "vitest";

import { PHP_FILE_HEADER } from "../src/index.js";

describe("generator core package", () => {
  it("exports the canonical generated file header", () => {
    expect(PHP_FILE_HEADER).toContain("DO NOT EDIT");
  });
});
