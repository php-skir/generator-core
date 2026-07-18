import { describe, expect, it } from "vitest";

import {
  buildPhpNameRegistry,
  normalizeSchema,
  toClassName,
  toPhpNamespaceSegment,
  toPropertyName,
  type SkirRecord,
} from "../src/index.js";

function record(key: string, name: string): SkirRecord {
  return {
    kind: "record",
    key,
    name: { text: name },
    recordType: "struct",
    fields: [],
  };
}

describe("PHP name conversion", () => {
  it("converts schema names to PHP identifiers", () => {
    expect(toClassName("get_user-profile status")).toBe("GetUserProfileStatus");
    expect(toPropertyName("get_user-profile status")).toBe("getUserProfileStatus");
    expect(toPhpNamespaceSegment("admin.api-v2")).toBe("AdminApiV2");
  });

  it("prefixes numeric-leading schema names with an underscore", () => {
    expect(toClassName("123-status")).toBe("_123Status");
    expect(toPropertyName("123-status")).toBe("_123Status");
    expect(toPhpNamespaceSegment("2026-api")).toBe("_2026Api");
  });
});

describe("buildPhpNameRegistry", () => {
  it("prefixes duplicate short record names with their module file names", () => {
    const usersUser = record("users-user", "User");
    const profilesUser = record("profiles-user", "User");
    const schema = normalizeSchema({
      modules: [
        { path: "admin/users.skir", records: [usersUser] },
        { path: "admin/profiles.skir", records: [profilesUser] },
      ],
    });

    const registry = buildPhpNameRegistry("App\\Skir", schema, (normalizedRecord) => (
      toClassName(normalizedRecord.qualifiedName.replaceAll(".", "_"))
    ));

    expect(registry.namesByIdentity.get("admin/users.skir::User")).toBe("UsersUser");
    expect(registry.namesByIdentity.get("admin/profiles.skir::User")).toBe("ProfilesUser");
    expect(registry.namesByRecordKey.get("users-user")).toBe("UsersUser");
    expect(registry.namesByRecordKey.get("profiles-user")).toBe("ProfilesUser");
  });

  it("rejects class names that differ only by case", () => {
    const schema = normalizeSchema({
      modules: [{
        path: "admin/users.skir",
        records: [record("upper-user", "User"), record("lower-user", "user")],
      }],
    });

    expect(() => buildPhpNameRegistry(
      "App\\Skir",
      schema,
      (normalizedRecord) => normalizedRecord.qualifiedName,
    )).toThrow(/case-insensitive PHP class collision.*User.*user/i);
  });

  it("rejects collisions introduced by deterministic prefixes", () => {
    const schema = normalizeSchema({
      modules: [
        { path: "admin/users.skir", records: [record("plain-user", "User")] },
        { path: "admin/users-.skir", records: [record("punctuated-user", "User")] },
      ],
    });

    expect(() => buildPhpNameRegistry("App\\Skir", schema, () => "User")).toThrow(
      /PHP class collision after deterministic prefixing/i,
    );
  });

  it("accepts legal underscore names and rejects invalid callback class names", () => {
    const schema = normalizeSchema({
      modules: [{ path: "admin/users.skir", records: [record("user", "User")] }],
    });

    expect(buildPhpNameRegistry("App\\Skir", schema, () => "_User123")
      .namesByRecordKey.get("user")).toBe("_User123");
    expect(() => buildPhpNameRegistry("App\\Skir", schema, () => "123-User"))
      .toThrow(/invalid PHP class name "123-User".*admin\/users\.skir::User/i);
  });
});
