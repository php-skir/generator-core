import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createImportRegistry,
  importClass,
  importClassAs,
  indent,
  PHP_FILE_HEADER,
  renderPhpFile,
  renderUseStatements,
  type ImportRegistry,
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

  it("plans colliding aliases independently of planning and lookup order", () => {
    const commonAddress = "Skir\\Common\\Address";
    const billingAddress = "Skir\\Billing\\Address";
    const forward = createImportRegistry([], [commonAddress, billingAddress]);
    const reverse = createImportRegistry([], [billingAddress, commonAddress]);

    expect(importClass(forward, commonAddress)).toBe("CommonAddress");
    expect(importClass(forward, billingAddress)).toBe("BillingAddress");
    expect(importClass(reverse, billingAddress)).toBe("BillingAddress");
    expect(importClass(reverse, commonAddress)).toBe("CommonAddress");
    expect(renderUseStatements(forward)).toEqual([
      "use Skir\\Billing\\Address as BillingAddress;",
      "use Skir\\Common\\Address as CommonAddress;",
    ]);
    expect(renderUseStatements(reverse)).toEqual(renderUseStatements(forward));
  });

  it("allows an adapter to override an unused planned alias explicitly", () => {
    const commonAddress = "Skir\\Common\\Address";
    const billingAddress = "Skir\\Billing\\Address";
    const registry = createImportRegistry([], [commonAddress, billingAddress]);

    expect(importClassAs(registry, commonAddress, "Address")).toBe("Address");
    expect(importClass(registry, commonAddress)).toBe("Address");
    expect(renderUseStatements(registry)).toEqual([
      "use Skir\\Common\\Address;",
    ]);
  });

  it("keeps other planned aliases stable after an explicit override", () => {
    const commonAddress = "Skir\\Common\\Address";
    const billingAddress = "Skir\\Billing\\Address";
    const registry = createImportRegistry([], [commonAddress, billingAddress]);

    expect(importClassAs(registry, commonAddress, "Address")).toBe("Address");
    expect(importClass(registry, billingAddress)).toBe("BillingAddress");
    expect(renderUseStatements(registry)).toEqual([
      "use Skir\\Billing\\Address as BillingAddress;",
      "use Skir\\Common\\Address;",
    ]);
  });

  it("returns the same explicit alias idempotently", () => {
    const registry = createImportRegistry([]);

    expect(importClassAs(registry, "Skir\\Common\\Address", "Address")).toBe("Address");
    expect(importClassAs(registry, "\\Skir\\Common\\Address", "Address")).toBe("Address");
    expect(renderUseStatements(registry)).toEqual([
      "use Skir\\Common\\Address;",
    ]);
  });

  it("rejects explicit aliases reserved by the registry", () => {
    const registry = createImportRegistry(["Address"]);

    expect(() => importClassAs(registry, "Skir\\Common\\Address", "address")).toThrow(
      /alias.*address.*reserved/i,
    );
    expect(renderUseStatements(registry)).toEqual([]);
  });

  it.each(["Bad-Name", "match"])(
    "rejects invalid or PHP-reserved explicit alias %s",
    (localName) => {
      const registry = createImportRegistry([]);

      expect(() => importClassAs(registry, "Skir\\Common\\Address", localName)).toThrow(
        /invalid PHP import alias|reserved PHP name/i,
      );
      expect(renderUseStatements(registry)).toEqual([]);
    },
  );

  it("rejects an explicit alias occupied case-insensitively by another import", () => {
    const registry = createImportRegistry([]);

    importClassAs(registry, "Skir\\Common\\Address", "Address");

    expect(() => importClassAs(registry, "Skir\\Billing\\Address", "address")).toThrow(
      /alias.*address.*already.*Skir\\Common\\Address/i,
    );
    expect(renderUseStatements(registry)).toEqual([
      "use Skir\\Common\\Address;",
    ]);
  });

  it("rejects a second used alias for the same class", () => {
    const registry = createImportRegistry([]);

    importClassAs(registry, "Skir\\Common\\Address", "Address");

    expect(() => importClassAs(registry, "Skir\\Common\\Address", "CommonAddress")).toThrow(
      /Skir\\Common\\Address.*already imported as Address.*CommonAddress/i,
    );
    expect(renderUseStatements(registry)).toEqual([
      "use Skir\\Common\\Address;",
    ]);
  });

  it("rejects an alias planned for another class without destabilizing the plan", () => {
    const commonAddress = "Skir\\Common\\Address";
    const billingAddress = "Skir\\Billing\\Address";
    const registry = createImportRegistry([], [commonAddress, billingAddress]);

    expect(() => importClassAs(registry, commonAddress, "BillingAddress")).toThrow(
      /alias.*BillingAddress.*planned.*Skir\\Billing\\Address/i,
    );
    expect(importClass(registry, commonAddress)).toBe("CommonAddress");
    expect(importClass(registry, billingAddress)).toBe("BillingAddress");
  });

  it("rejects invalid and case-conflicting explicit class names", () => {
    const registry = createImportRegistry([], ["Skir\\Common\\Address"]);

    expect(() => importClassAs(registry, "Skir\\Bad-Name", "Address")).toThrow(
      /invalid PHP fully qualified class name.*Bad-Name/i,
    );
    expect(() => importClassAs(registry, "skir\\common\\address", "Address")).toThrow(
      /same case-insensitive PHP class.*Skir\\Common\\Address.*skir\\common\\address/i,
    );
  });

  it("rejects a forged registry for explicit aliases", () => {
    const injectedRegistry: ImportRegistry = {
      reservedNames: new Set(),
      imports: new Map(),
    };

    expect(() => importClassAs(injectedRegistry, "Skir\\Common\\Address", "Address")).toThrow(
      /registry.*createImportRegistry/i,
    );
  });

  it("rejects an unplanned late basename collision that cannot be remapped safely", () => {
    const registry = createImportRegistry([]);

    expect(importClass(registry, "Skir\\Common\\Address")).toBe("Address");
    expect(() => importClass(registry, "Skir\\Billing\\Address")).toThrow(
      /preplan.*colliding imports.*createImportRegistry/i,
    );
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

  it("renders preferred used imports first with their actual aliases", () => {
    const registry = createImportRegistry(
      ["Type"],
      ["Skir\\Runtime\\Type", "App\\Alpha", "Vendor\\Zed"],
    );

    importClass(registry, "Vendor\\Zed");
    importClass(registry, "Skir\\Runtime\\Type");
    importClass(registry, "App\\Alpha");

    expect(renderUseStatements(registry, [
      "\\Skir\\Runtime\\Type",
      "Skir\\Runtime\\Unused",
      "Skir\\Runtime\\Type",
    ])).toEqual([
      "use Skir\\Runtime\\Type as RuntimeType;",
      "use App\\Alpha;",
      "use Vendor\\Zed;",
    ]);
  });

  it("matches and deduplicates preferred imports case-insensitively", () => {
    const registry = createImportRegistry(
      ["Zed"],
      ["App\\Alpha", "Vendor\\Zed"],
    );

    importClass(registry, "App\\Alpha");
    importClass(registry, "Vendor\\Zed");

    expect(renderUseStatements(registry, [
      "vendor\\zed",
      "\\VENDOR\\ZED",
      "VeNdOr\\ZeD",
    ])).toEqual([
      "use Vendor\\Zed as VendorZed;",
      "use App\\Alpha;",
    ]);
  });

  it("keeps global deterministic sorting when no preferred imports are supplied", () => {
    const registry = createImportRegistry([]);

    importClass(registry, "Vendor\\Zed");
    importClass(registry, "Skir\\Runtime\\Type");
    importClass(registry, "Vendor\\Alpha");

    expect(renderUseStatements(registry)).toEqual([
      "use Skir\\Runtime\\Type;",
      "use Vendor\\Alpha;",
      "use Vendor\\Zed;",
    ]);
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

  it("exposes imports as a runtime read-only view", () => {
    const registry = createImportRegistry([]);

    expectTypeOf(registry.imports).toEqualTypeOf<ReadonlyMap<string, string>>();
    expect("set" in registry.imports).toBe(false);
    expect("delete" in registry.imports).toBe(false);
    expect("clear" in registry.imports).toBe(false);

    importClass(registry, "Skir\\Common\\Address");

    expect(registry.imports.get("Address")).toBe("Skir\\Common\\Address");
  });

  it("rejects structurally injected import state", () => {
    const injectedRegistry: ImportRegistry = {
      reservedNames: new Set(),
      imports: new Map([["Match", "Vendor\\Match"]]),
    };

    expect(() => renderUseStatements(injectedRegistry)).toThrow(
      /registry.*createImportRegistry/i,
    );
  });

  it("rejects PHP reserved class names case-insensitively", () => {
    for (const reservedClassName of ["Match", "ENUM", "class", "Interface", "trait"]) {
      const registry = createImportRegistry([]);

      expect(() => importClass(registry, `Vendor\\${reservedClassName}`)).toThrow(
        new RegExp(`terminal class segment.*${reservedClassName}.*reserved`, "i"),
      );
    }

    expect(() => createImportRegistry(["trait"])).toThrow(/reserved PHP name.*trait/i);
  });

  it("skips reserved namespace-derived alias candidates", () => {
    const registry = createImportRegistry(
      ["ch"],
      ["Vendor\\Mat\\ch"],
    );

    expect(importClass(registry, "Vendor\\Mat\\ch")).toBe("VendorMatCh");
    expect(renderUseStatements(registry)).toEqual([
      "use Vendor\\Mat\\ch as VendorMatCh;",
    ]);
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
