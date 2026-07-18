import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACE, PhpNamespace } from "../src/index.js";

const PHP_NAMESPACE_ERROR = "Namespace must be a canonical PHP namespace using ASCII identifier segments separated by single backslashes.";

describe("PhpNamespace", () => {
  it("exports the shared default namespace", () => {
    expect(DEFAULT_NAMESPACE).toBe("Skir");
  });

  it.each([
    "Skir",
    "Company\\Contracts",
    "_Internal\\Version2",
  ])("accepts canonical ASCII PHP namespace %j", (namespace) => {
    expect(PhpNamespace.parse(namespace)).toBe(namespace);
  });

  it.each([
    "",
    "\\Skir",
    "Skir\\",
    "Skir\\\\Contracts",
    "9Skir",
    "Skir\\2Contracts",
    "Skir/Contracts",
    "Skir\\Módulo",
    "Skir\\Bad-Name",
    " Skir",
    "Skir ",
  ])("rejects non-canonical PHP namespace %j with the approved error", (namespace) => {
    const result = PhpNamespace.safeParse(namespace);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(PHP_NAMESPACE_ERROR);
    }
  });
});
