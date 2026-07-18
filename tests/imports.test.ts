import { describe, expect, it } from "vitest";

import {
  createImportRegistry,
  importClass,
  indent,
  PHP_FILE_HEADER,
  renderPhpFile,
  renderUseStatements,
} from "../src/index.js";

describe("PHP imports", () => {
  it("reuses a canonical import without emitting a duplicate statement", () => {
    const registry = createImportRegistry([]);

    expect(importClass(registry, "Skir\\Common\\Address")).toBe("Address");
    expect(importClass(registry, "\\Skir\\Common\\Address")).toBe("Address");
    expect(renderUseStatements(registry)).toEqual([
      "use Skir\\Common\\Address;",
    ]);
  });

  it("aliases generated and runtime imports that collide with reserved names", () => {
    const registry = createImportRegistry(["Type", "User"]);

    expect(importClass(registry, "Skir\\Runtime\\Type")).toBe("RuntimeType");
    expect(importClass(registry, "Skir\\Admin\\User")).toBe("AdminUser");
    expect(renderUseStatements(registry)).toEqual([
      "use Skir\\Admin\\User as AdminUser;",
      "use Skir\\Runtime\\Type as RuntimeType;",
    ]);
  });

  it("assigns unique aliases to cross-module records with the same short name", () => {
    const registry = createImportRegistry([]);

    expect(importClass(registry, "Skir\\Common\\Address")).toBe("Address");
    expect(importClass(registry, "Skir\\Billing\\Address")).toBe("BillingAddress");
    expect(renderUseStatements(registry)).toEqual([
      "use Skir\\Billing\\Address as BillingAddress;",
      "use Skir\\Common\\Address;",
    ]);
  });

  it("sorts use statements independently of import lookup order", () => {
    const forward = createImportRegistry([]);
    const reverse = createImportRegistry([]);

    importClass(forward, "Vendor\\Zed");
    importClass(forward, "Vendor\\Alpha");
    importClass(reverse, "Vendor\\Alpha");
    importClass(reverse, "Vendor\\Zed");

    expect(renderUseStatements(forward)).toEqual([
      "use Vendor\\Alpha;",
      "use Vendor\\Zed;",
    ]);
    expect(renderUseStatements(reverse)).toEqual(renderUseStatements(forward));
  });

  it("handles PHP names case-insensitively without duplicate local aliases", () => {
    const registry = createImportRegistry(["type"]);

    expect(importClass(registry, "Skir\\Runtime\\Type")).toBe("RuntimeType");
    expect(importClass(registry, "Other\\runtimeType")).toBe("OtherRuntimeType");
    expect(() => importClass(registry, "skir\\runtime\\type")).toThrow(
      /same case-insensitive PHP class.*Skir\\Runtime\\Type.*skir\\runtime\\type/i,
    );

    const aliases = [...registry.imports.keys()].map((alias) => alias.toLowerCase());

    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("rejects empty and invalid fully qualified class names with actionable errors", () => {
    const registry = createImportRegistry([]);

    expect(() => importClass(registry, "\\")).toThrow(/empty PHP fully qualified class name/i);
    expect(() => importClass(registry, "Skir\\Bad-Name")).toThrow(
      /invalid PHP fully qualified class name.*Bad-Name/i,
    );
    expect(() => importClass(registry, "Skir\\\\Type")).toThrow(
      /invalid PHP fully qualified class name.*empty namespace segment/i,
    );
  });
});

describe("PHP rendering", () => {
  it("indents non-empty lines and preserves empty lines", () => {
    expect(indent("first\n\n  second\n")).toBe("    first\n\n      second\n");
  });

  it("renders the established PHP file sequence exactly", () => {
    expect(renderPhpFile({
      namespace: "Skir\\Admin",
      imports: [
        "use Skir\\Runtime\\Type;",
        "use Skir\\Common\\Address;",
      ],
      body: "final readonly class User\n{\n}",
    })).toBe([
      "<?php",
      "",
      "declare(strict_types=1);",
      "",
      PHP_FILE_HEADER,
      "",
      "namespace Skir\\Admin;",
      "",
      "use Skir\\Runtime\\Type;",
      "use Skir\\Common\\Address;",
      "",
      "final readonly class User",
      "{",
      "}",
      "",
    ].join("\n"));
  });

  it("renders an empty import list and body without extra whitespace", () => {
    expect(renderPhpFile({
      namespace: "Skir",
      imports: [],
      body: "",
    })).toBe([
      "<?php",
      "",
      "declare(strict_types=1);",
      "",
      PHP_FILE_HEADER,
      "",
      "namespace Skir;",
      "",
      "",
    ].join("\n"));
  });
});
