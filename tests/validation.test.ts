import type { Token } from "skir-internal";
import { describe, expect, it } from "vitest";

import {
  normalizeSchema,
  resolveValidationRules,
  ValidationConfig,
  ValidationRule,
  type SkirRecord,
  type SkirRecordLocation,
} from "../src/index.js";

function token(text: string, modulePath = "admin/users.skir"): Token {
  const line = {
    lineNumber: 0,
    line: text,
    position: 0,
    modulePath,
  };

  return {
    text,
    originalText: text,
    position: 0,
    line,
    colNumber: 0,
  };
}

function validationSchema() {
  const envelope: SkirRecord = {
    kind: "record",
    name: token("Envelope"),
    recordType: "struct",
    fields: [],
  };
  const metadata: SkirRecord = {
    kind: "record",
    name: token("Metadata"),
    recordType: "struct",
    fields: [
      {
        kind: "field",
        name: token("display_name"),
        number: 1,
        type: { kind: "primitive", primitive: "string" },
      },
      {
        kind: "field",
        name: token("email_address"),
        number: 2,
        type: { kind: "primitive", primitive: "string" },
      },
    ],
    removedNumbers: [3],
  };
  const account: SkirRecord = {
    kind: "record",
    name: token("Account"),
    recordType: "struct",
    fields: [{
      kind: "field",
      name: token("first_name"),
      number: 1,
      type: { kind: "primitive", primitive: "string" },
    }],
  };
  const status: SkirRecord = {
    kind: "record",
    name: token("Status"),
    recordType: "enum",
    fields: [
      { kind: "field", name: token("Active"), number: 0 },
      {
        kind: "field",
        name: token("ExpiresAt"),
        number: 1,
        type: { kind: "primitive", primitive: "timestamp" },
      },
    ],
  };
  const nestedMetadata: SkirRecordLocation = {
    kind: "record-location",
    record: metadata,
    recordAncestors: [envelope, metadata],
    modulePath: "admin/users.skir",
  };
  const external: SkirRecord = {
    kind: "record",
    name: token("External", "external/types.skir"),
    recordType: "struct",
    fields: [{
      kind: "field",
      name: token("value", "external/types.skir"),
      number: 1,
      type: { kind: "primitive", primitive: "string" },
    }],
  };
  const externalLocation: SkirRecordLocation = {
    kind: "record-location",
    record: external,
    recordAncestors: [external],
    modulePath: "external/types.skir",
  };

  return normalizeSchema({
    modules: [{
      path: "admin/users.skir",
      records: [
        {
          kind: "record-location",
          record: envelope,
          recordAncestors: [envelope],
          modulePath: "admin/users.skir",
        },
        nestedMetadata,
        {
          kind: "record-location",
          record: account,
          recordAncestors: [account],
          modulePath: "admin/users.skir",
        },
        {
          kind: "record-location",
          record: status,
          recordAncestors: [status],
          modulePath: "admin/users.skir",
        },
      ],
    }],
    recordMap: new Map([["external-key", externalLocation]]),
  });
}

describe("ValidationConfig", () => {
  it("defaults missing configuration to an empty object", () => {
    expect(ValidationConfig.parse(undefined)).toEqual({});
  });

  it("accepts whitespace-only rules without transforming them", () => {
    expect(ValidationRule.parse(" ")).toBe(" ");
  });

  it.each([
    {
      name: "empty rules",
      input: { module: { Record: { field: [""] } } },
      path: ["module", "Record", "field", 0],
      message: "Validation rules must be non-empty strings.",
    },
    {
      name: "non-string rules",
      input: { module: { Record: { field: [123] } } },
      path: ["module", "Record", "field", 0],
      message: "Invalid input: expected string, received number",
    },
    {
      name: "empty rule arrays",
      input: { module: { Record: { field: [] } } },
      path: ["module", "Record", "field"],
      message: "Too small: expected array to have >=1 items",
    },
  ])("rejects $name with a useful issue", ({ input, path, message }) => {
    const result = ValidationConfig.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({ path, message });
    }
  });
});

describe("resolveValidationRules", () => {
  it("resolves generated records and original Skir field names in input order", () => {
    const schema = validationSchema();
    const config = ValidationConfig.parse({
      "admin/users.skir": {
        "Envelope.Metadata": {
          email_address: ["required", "email:rfc"],
          display_name: ["min:2"],
        },
        Account: {
          first_name: ["required", "max:80"],
        },
      },
    });

    const resolved = resolveValidationRules(schema, config);

    expect([...resolved.keys()]).toEqual([
      "admin/users.skir::Envelope.Metadata",
      "admin/users.skir::Account",
    ]);
    expect([...resolved.get("admin/users.skir::Envelope.Metadata")?.entries() ?? []]).toEqual([
      ["email_address", ["required", "email:rfc"]],
      ["display_name", ["min:2"]],
    ]);
    expect([...resolved.get("admin/users.skir::Account")?.entries() ?? []]).toEqual([
      ["first_name", ["required", "max:80"]],
    ]);
    expect(resolved.has("admin/users.skir::Envelope")).toBe(false);
  });

  it("does not include configured records that have no field overlays", () => {
    const resolved = resolveValidationRules(validationSchema(), {
      "admin/users.skir": { Account: {} },
    });

    expect([...resolved]).toEqual([]);
  });

  it("defensively copies configured rule arrays", () => {
    const rules = ["required", "max:80"];
    const config = { "admin/users.skir": { Account: { first_name: rules } } };
    const resolved = resolveValidationRules(validationSchema(), config);

    rules[0] = "nullable";
    rules.push("min:2");

    expect(resolved.get("admin/users.skir::Account")?.get("first_name")).toEqual([
      "required",
      "max:80",
    ]);
  });

  it("rejects an unknown module with the complete selector", () => {
    expect(() => resolveValidationRules(validationSchema(), {
      "missing/users.skir": { Account: { first_name: ["required"] } },
    })).toThrow('Unknown validation module "missing/users.skir".');
  });

  it("does not expose external record-map-only identities as modules", () => {
    expect(() => resolveValidationRules(validationSchema(), {
      "external/types.skir": { External: { value: ["required"] } },
    })).toThrow('Unknown validation module "external/types.skir".');
  });

  it("rejects an unknown generated record with the complete selector", () => {
    expect(() => resolveValidationRules(validationSchema(), {
      "admin/users.skir": { Missing: { value: ["required"] } },
    })).toThrow('Unknown validation record "admin/users.skir::Missing".');
  });

  it("rejects PHP property names instead of original Skir field names", () => {
    expect(() => resolveValidationRules(validationSchema(), {
      "admin/users.skir": {
        "Envelope.Metadata": { displayName: ["required"] },
      },
    })).toThrow('Unknown validation field "admin/users.skir::Envelope.Metadata.displayName".');
  });

  it("rejects unknown fields with the complete selector", () => {
    expect(() => resolveValidationRules(validationSchema(), {
      "admin/users.skir": { Account: { missing: ["required"] } },
    })).toThrow('Unknown validation field "admin/users.skir::Account.missing".');
  });

  it("rejects enum variants because they are not struct payload fields", () => {
    expect(() => resolveValidationRules(validationSchema(), {
      "admin/users.skir": { Status: { ExpiresAt: ["required"] } },
    })).toThrow(
      'Validation field "admin/users.skir::Status.ExpiresAt" targets an enum variant; only struct payload fields can receive validation.',
    );
  });

  it("rejects removed field numbers because they have no payload", () => {
    expect(() => resolveValidationRules(validationSchema(), {
      "admin/users.skir": { "Envelope.Metadata": { "3": ["required"] } },
    })).toThrow(
      'Validation field "admin/users.skir::Envelope.Metadata.3" targets removed field number 3; only struct payload fields can receive validation.',
    );
  });
});
