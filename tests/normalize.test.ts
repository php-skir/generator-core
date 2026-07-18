import type { Field, Record, RecordLocation, Token } from "skir-internal";
import { describe, expect, it } from "vitest";

import {
  buildPhpNameRegistry,
  normalizeSchema,
  toClassName,
  type SkirModule,
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

describe("normalizeSchema", () => {
  it("normalizes producer-shaped records, imported references, and removed numbers", () => {
    const organization: SkirRecord = {
      kind: "record",
      key: "organization-key",
      name: token("Organization", "common/organization.skir"),
      recordType: "struct",
      fields: [],
      removedNumbers: [],
    };
    const user: SkirRecord = {
      kind: "record",
      key: "user-key",
      name: token("User"),
      recordType: "struct",
      fields: [
        {
          kind: "field",
          name: token("organization"),
          number: 1,
          type: {
            kind: "record",
            key: "organization-key",
            recordType: "struct",
            nameParts: [{ token: token("Organization") }],
          },
        },
        {
          kind: "field",
          name: token("tags"),
          number: 3,
          type: {
            kind: "optional",
            other: {
              kind: "array",
              item: { kind: "primitive", primitive: "string" },
            },
          },
        },
      ],
      removedNumbers: [2],
    };
    const profile: SkirRecord = {
      kind: "record",
      key: "profile-key",
      name: token("Profile"),
      recordType: "struct",
      fields: [{ kind: "removed", number: 4 }],
      removedNumbers: [4, 5],
    };
    const nestedProfileLocation: SkirRecordLocation = {
      kind: "record-location",
      record: profile,
      recordAncestors: [user, profile],
      modulePath: "admin/users.skir",
    };
    const modules: readonly SkirModule[] = [
      {
        path: "admin/users.skir",
        records: [
          {
            kind: "record-location",
            record: user,
            recordAncestors: [user],
            modulePath: "admin/users.skir",
          },
          nestedProfileLocation,
        ],
        methods: [
          {
            kind: "method",
            name: token("GetUser"),
            number: 7,
            requestType: { kind: "record", key: "user-key", recordType: "struct" },
            responseType: { kind: "record", key: "profile-key", recordType: "struct" },
          },
        ],
      },
      {
        path: "common/organization.skir",
        records: [
          {
            kind: "record-location",
            record: organization,
            recordAncestors: [organization],
            modulePath: "common/organization.skir",
          },
        ],
      },
    ];
    const recordMap = new Map<string, SkirRecordLocation>([
      [
        "organization-key",
        {
          kind: "record-location",
          record: organization,
          recordAncestors: [organization],
          modulePath: "common/organization.skir",
        },
      ],
      [
        "user-key",
        {
          kind: "record-location",
          record: user,
          recordAncestors: [user],
          modulePath: "admin/users.skir",
        },
      ],
      ["profile-key", nestedProfileLocation],
    ]);

    const schema = normalizeSchema({ modules, recordMap });

    expect(schema.modules[0]).toMatchObject({
      path: "admin/users.skir",
      sourceDirectory: "admin",
      namespaceSegments: ["Admin"],
      moduleIdentity: "Admin",
    });
    expect(schema.recordsByIdentity.get("admin/users.skir::User")?.qualifiedName).toBe("User");
    expect(schema.recordsByIdentity.get("admin/users.skir::User.Profile")).toMatchObject({
      qualifiedName: "User.Profile",
      key: "profile-key",
    });
    expect(schema.recordsByKey.get("profile-key")?.identity).toBe("admin/users.skir::User.Profile");
    expect(schema.modules[0]?.records[0]?.fields).toEqual([
      {
        kind: "field",
        name: "organization",
        number: 1,
        hasPayload: true,
        type: {
          kind: "record",
          recordIdentity: "common/organization.skir::Organization",
          recordType: "struct",
        },
      },
      { kind: "removed", number: 2 },
      {
        kind: "field",
        name: "tags",
        number: 3,
        hasPayload: true,
        type: {
          kind: "optional",
          inner: { kind: "array", item: { kind: "string" } },
        },
      },
    ]);
    expect(schema.modules[0]?.records[1]?.fields).toEqual([
      { kind: "removed", number: 4 },
      { kind: "removed", number: 5 },
    ]);
    expect(schema.modules[0]?.methods[0]).toEqual({
      name: "GetUser",
      number: 7,
      requestType: {
        kind: "record",
        recordIdentity: "admin/users.skir::User",
        recordType: "struct",
      },
      responseType: {
        kind: "record",
        recordIdentity: "admin/users.skir::User.Profile",
        recordType: "struct",
      },
    });
  });

  it("maps root modules to _Root", () => {
    const schema = normalizeSchema({ modules: [{ path: "health.skir" }] });

    expect(schema.modules[0]).toMatchObject({
      sourceDirectory: "",
      namespaceSegments: [],
      moduleIdentity: "_Root",
    });
  });

  it("distinguishes producer enum constants from payload variants", () => {
    const emptyDoc = { text: "", pieces: [] };
    const unknownVariant: Field = {
      kind: "field",
      name: token("Unknown", "status.skir"),
      number: 0,
      doc: emptyDoc,
      unresolvedType: undefined,
      inlineRecord: undefined,
      type: undefined,
      isRecursive: false,
    };
    const expiresAtVariant: Field = {
      kind: "field",
      name: token("ExpiresAt", "status.skir"),
      number: 1,
      doc: emptyDoc,
      unresolvedType: { kind: "primitive", primitive: "timestamp" },
      inlineRecord: undefined,
      type: { kind: "primitive", primitive: "timestamp" },
      isRecursive: false,
    };
    const statusRecord: Record = {
      kind: "record",
      key: "status-key",
      name: token("Status", "status.skir"),
      recordType: "enum",
      doc: emptyDoc,
      nameToDeclaration: { Unknown: unknownVariant, ExpiresAt: expiresAtVariant },
      declarations: [unknownVariant, expiresAtVariant],
      fields: [unknownVariant, expiresAtVariant],
      nestedRecords: [],
      removedNumbers: [],
      recordNumber: null,
      numSlots: 0,
      numSlotsInclRemovedNumbers: 0,
    };
    const statusLocation: RecordLocation = {
      kind: "record-location",
      record: statusRecord,
      recordAncestors: [statusRecord],
      modulePath: "status.skir",
    };

    const schema = normalizeSchema({
      modules: [{ path: "status.skir", records: [statusLocation] }],
      recordMap: new Map([["status-key", statusLocation]]),
    });

    expect(schema.modules[0]?.records[0]?.fields).toEqual([
      {
        kind: "field",
        name: "Unknown",
        number: 0,
        hasPayload: false,
      },
      {
        kind: "field",
        name: "ExpiresAt",
        number: 1,
        hasPayload: true,
        type: { kind: "timestamp" },
      },
    ]);
  });

  it("keeps struct fields typed and rejects a missing resolved type", () => {
    const validSchema = normalizeSchema({
      modules: [{
        path: "flags.skir",
        records: [{
          kind: "record",
          key: "flags-key",
          name: token("Flags", "flags.skir"),
          recordType: "struct",
          fields: [{
            kind: "field",
            name: token("active", "flags.skir"),
            number: 0,
            type: { kind: "primitive", primitive: "bool" },
          }],
        }],
      }],
    });

    expect(validSchema.modules[0]?.records[0]?.fields[0]).toEqual({
      kind: "field",
      name: "active",
      number: 0,
      hasPayload: true,
      type: { kind: "bool" },
    });
    expect(() => normalizeSchema({
      modules: [{
        path: "broken.skir",
        records: [{
          kind: "record",
          key: "broken-key",
          name: token("Broken", "broken.skir"),
          recordType: "struct",
          fields: [{
            kind: "field",
            name: token("missing", "broken.skir"),
            number: 0,
          }],
        }],
      }],
    })).toThrow(/struct field "missing".*missing.*type/i);
  });

  it("rejects case-insensitive module namespace collisions", () => {
    expect(() => normalizeSchema({
      modules: [
        { path: "user-profile/profile.skir" },
        { path: "user_profile/account.skir" },
      ],
    })).toThrow(/UserProfile.*user-profile.*user_profile/i);
  });

  it("reports unresolved imported record keys", () => {
    expect(() => normalizeSchema({
      modules: [{
        path: "admin/users.skir",
        methods: [{
          kind: "method",
          name: token("Missing"),
          number: 1,
          requestType: { kind: "record", key: "missing-key", recordType: "struct" },
          responseType: "bool",
        }],
      }],
      recordMap: new Map(),
    })).toThrow(/record key "missing-key".*could not be resolved/i);
  });

  it("indexes external record locations by their authoritative map keys without generating them", () => {
    const addressRecord: SkirRecord = {
      kind: "record",
      key: "stale-record-key",
      name: token("Address", "common/address.skir"),
      recordType: "struct",
      fields: [{
        kind: "field",
        name: token("city", "common/address.skir"),
        number: 0,
        type: { kind: "primitive", primitive: "string" },
      }],
    };
    const addressLocation: SkirRecordLocation = {
      kind: "record-location",
      record: addressRecord,
      recordAncestors: [addressRecord],
      modulePath: "common/address.skir",
    };
    const schema = normalizeSchema({
      recordMap: new Map([
        ["common/address.skir:0", addressLocation],
        ["address-alias", addressLocation],
      ]),
      modules: [{
        path: "admin/users.skir",
        records: [{
          kind: "struct",
          name: token("User"),
          fields: [{
            kind: "field",
            name: token("address"),
            number: 0,
            type: {
              kind: "record",
              key: "common/address.skir:0",
              nameParts: [{ token: token("Address", "common/address.skir") }],
            },
          }],
        }],
      }],
    });
    const externalRecord = schema.recordsByIdentity.get("common/address.skir::Address");
    const names = buildPhpNameRegistry("App\\Skir", schema, (record) => (
      toClassName(record.qualifiedName)
    ));

    expect(schema.modules).toHaveLength(1);
    expect(schema.modules[0]?.records.map((record) => record.identity)).toEqual([
      "admin/users.skir::User",
    ]);
    expect(externalRecord).toMatchObject({
      identity: "common/address.skir::Address",
      modulePath: "common/address.skir",
      qualifiedName: "Address",
      recordType: "struct",
      fields: [],
      key: "address-alias",
    });
    expect(schema.recordsByKey.get("common/address.skir:0")).toBe(externalRecord);
    expect(schema.recordsByKey.get("address-alias")).toBe(externalRecord);
    expect(schema.recordsByKey.has("stale-record-key")).toBe(false);
    expect(schema.modules[0]?.records[0]?.fields[0]).toMatchObject({
      type: {
        kind: "record",
        recordIdentity: "common/address.skir::Address",
        recordType: "struct",
      },
    });
    expect(names.namesByIdentity.get("common/address.skir::Address")).toBe("Address");
    expect(names.namesByRecordKey.get("common/address.skir:0")).toBe("Address");
    expect(names.namesByRecordKey.get("address-alias")).toBe("Address");
  });

  it("associates authoritative map-key aliases with generated records that omit their own key", () => {
    const user: SkirRecord = {
      kind: "record",
      name: token("User"),
      recordType: "struct",
      fields: [],
    };
    const location: SkirRecordLocation = {
      kind: "record-location",
      record: user,
      recordAncestors: [user],
      modulePath: "admin/users.skir",
    };
    const schema = normalizeSchema({
      modules: [{ path: "admin/users.skir", records: [location] }],
      recordMap: new Map([
        ["admin/users.skir:0", location],
        ["user-alias", location],
      ]),
    });
    const generatedRecord = schema.modules[0]?.records[0];

    expect(schema.recordsByKey.get("admin/users.skir:0")).toBe(generatedRecord);
    expect(schema.recordsByKey.get("user-alias")).toBe(generatedRecord);
    expect(schema.recordsByIdentity.size).toBe(1);
  });

  it("preserves exact PHP class metadata for generated and external records through aliases", () => {
    const generatedUser: SkirRecord = {
      kind: "record",
      name: token("User"),
      recordType: "struct",
      fields: [],
      phpClassName: "Exact-Generated-Override",
    };
    const externalAddress: SkirRecord = {
      kind: "record",
      name: token("Address", "common/address.skir"),
      recordType: "struct",
      fields: [],
      phpClassName: "Exact\\External\\Override",
    };
    const generatedLocation: SkirRecordLocation = {
      kind: "record-location",
      record: generatedUser,
      recordAncestors: [generatedUser],
      modulePath: "admin/users.skir",
    };
    const externalLocation: SkirRecordLocation = {
      kind: "record-location",
      record: externalAddress,
      recordAncestors: [externalAddress],
      modulePath: "common/address.skir",
    };
    const schema = normalizeSchema({
      modules: [{ path: "admin/users.skir", records: [generatedLocation] }],
      recordMap: new Map([
        ["address-alias", externalLocation],
        ["common/address.skir:0", externalLocation],
        ["user-alias", generatedLocation],
      ]),
    });
    const normalizedGenerated = schema.modules[0]?.records[0];
    const normalizedExternal = schema.recordsByIdentity.get("common/address.skir::Address");

    expect(normalizedGenerated?.phpClassName).toBe("Exact-Generated-Override");
    expect(schema.recordsByIdentity.get("admin/users.skir::User")).toBe(normalizedGenerated);
    expect(schema.recordsByKey.get("user-alias")).toBe(normalizedGenerated);
    expect(normalizedExternal?.phpClassName).toBe("Exact\\External\\Override");
    expect(schema.recordsByKey.get("address-alias")).toBe(normalizedExternal);
    expect(schema.recordsByKey.get("common/address.skir:0")).toBe(normalizedExternal);
  });

  it("keeps generated PHP class metadata and rejects incompatible metadata reuse", () => {
    const generatedUser: SkirRecord = {
      kind: "record",
      name: token("User"),
      recordType: "struct",
      fields: [],
      phpClassName: "GeneratedUser",
    };
    const generatedLocation: SkirRecordLocation = {
      kind: "record-location",
      record: generatedUser,
      recordAncestors: [generatedUser],
      modulePath: "admin/users.skir",
    };
    const equivalentMapRecord: SkirRecord = {
      kind: "record",
      name: token("User"),
      recordType: "struct",
      fields: [],
    };
    const schema = normalizeSchema({
      modules: [{ path: "admin/users.skir", records: [generatedLocation] }],
      recordMap: new Map([["user-alias", {
        kind: "record-location",
        record: equivalentMapRecord,
        recordAncestors: [equivalentMapRecord],
        modulePath: "admin/users.skir",
      }]]),
    });

    expect(schema.recordsByKey.get("user-alias")?.phpClassName).toBe("GeneratedUser");

    const conflictingMapRecord: SkirRecord = {
      ...equivalentMapRecord,
      phpClassName: "ConflictingUser",
    };

    expect(() => normalizeSchema({
      modules: [{ path: "admin/users.skir", records: [generatedLocation] }],
      recordMap: new Map([["user-alias", {
        kind: "record-location",
        record: conflictingMapRecord,
        recordAncestors: [conflictingMapRecord],
        modulePath: "admin/users.skir",
      }]]),
    })).toThrow(/admin\/users\.skir::User.*GeneratedUser.*ConflictingUser/i);
  });

  it("retains authoritative PHP class metadata when the generated record omits it", () => {
    const generatedUser: SkirRecord = {
      kind: "record",
      name: token("User"),
      recordType: "struct",
      fields: [],
    };
    const authoritativeUser: SkirRecord = {
      ...generatedUser,
      phpClassName: "AuthoritativeUser",
    };
    const schema = normalizeSchema({
      modules: [{ path: "admin/users.skir", records: [generatedUser] }],
      recordMap: new Map([["user-key", {
        kind: "record-location",
        record: authoritativeUser,
        recordAncestors: [authoritativeUser],
        modulePath: "admin/users.skir",
      }]]),
    });
    const normalizedUser = schema.modules[0]?.records[0];

    expect(normalizedUser?.phpClassName).toBe("AuthoritativeUser");
    expect(schema.recordsByIdentity.get("admin/users.skir::User")).toBe(normalizedUser);
    expect(schema.recordsByKey.get("user-key")).toBe(normalizedUser);
  });

  it("rejects conflicting authoritative map keys and record types", () => {
    const generatedUser: SkirRecord = {
      kind: "record",
      key: "shared-key",
      name: token("User"),
      recordType: "struct",
      fields: [],
    };
    const externalStatus: SkirRecord = {
      kind: "record",
      name: token("Status", "common/status.skir"),
      recordType: "enum",
      fields: [],
    };
    const conflictingUser: SkirRecord = {
      kind: "record",
      name: token("User"),
      recordType: "enum",
      fields: [],
    };

    expect(() => normalizeSchema({
      modules: [{ path: "admin/users.skir", records: [generatedUser] }],
      recordMap: new Map([["shared-key", {
        kind: "record-location",
        record: externalStatus,
        recordAncestors: [externalStatus],
        modulePath: "common/status.skir",
      }]]),
    })).toThrow(/record key "shared-key".*admin\/users\.skir::User.*common\/status\.skir::Status/i);

    expect(() => normalizeSchema({
      modules: [{ path: "admin/users.skir", records: [generatedUser] }],
      recordMap: new Map([["user-alias", {
        kind: "record-location",
        record: conflictingUser,
        recordAncestors: [conflictingUser],
        modulePath: "admin/users.skir",
      }]]),
    })).toThrow(/admin\/users\.skir::User.*struct.*enum/i);
  });
});
