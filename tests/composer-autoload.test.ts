import { describe, expect, it } from "vitest";

import {
  ComposerAutoloadConflictError,
  ensureComposerPsr4Mapping,
  MalformedComposerPsr4PrefixError,
} from "../src/index.js";

describe("ensureComposerPsr4Mapping", () => {
  it("adds a normalized PSR-4 mapping without reformatting unrelated content", () => {
    const source = `{
  "name": "example/project",
  "autoload": {
    "classmap": ["src/Legacy"]
  },
  "require": {}
}
`;

    const result = ensureComposerPsr4Mapping(source, "Skir", "./generated\\php\\skirout");

    expect(result.changed).toBe(true);
    expect(result.namespace).toBe("Skir\\");
    expect(result.paths).toBe("generated/php/skirout/");
    expect(JSON.parse(result.source).autoload).toEqual({
      classmap: ["src/Legacy"],
      "psr-4": {
        "Skir\\": "generated/php/skirout/",
      },
    });
    expect(result.source.indexOf('"name"')).toBeLessThan(result.source.indexOf('"autoload"'));
    expect(result.source.indexOf('"autoload"')).toBeLessThan(result.source.indexOf('"require"'));
  });

  it("leaves an equivalent normalized mapping byte-for-byte unchanged", () => {
    const source = `{
  "autoload": {
    "psr-4": {
      "Skir\\\\": "generated/php/skirout/"
    }
  }
}
`;

    expect(ensureComposerPsr4Mapping(source, "Skir", "./generated\\php\\skirout"))
      .toEqual({
        changed: false,
        namespace: "Skir\\",
        paths: "generated/php/skirout/",
        source,
      });
  });

  it("preserves ordered output directories", () => {
    const result = ensureComposerPsr4Mapping(
      "{}\n",
      "Skir",
      ["./generated\\primary", "generated/fallback/"],
    );

    expect(result.paths).toEqual([
      "generated/primary/",
      "generated/fallback/",
    ]);
    expect(JSON.parse(result.source).autoload["psr-4"]["Skir\\"]).toEqual([
      "generated/primary/",
      "generated/fallback/",
    ]);
  });

  it("preserves an unrelated empty fallback prefix", () => {
    const result = ensureComposerPsr4Mapping(
      '{"autoload":{"psr-4":{"":"src/"}}}\n',
      "Skir",
      "generated/skirout",
    );

    expect(JSON.parse(result.source).autoload["psr-4"]).toEqual({
      "": "src/",
      "Skir\\": "generated/skirout/",
    });
  });

  it.each([
    "Skir",
    "Skir/",
    " Skir\\",
    "Skir\\ ",
    "Skir\\\\",
  ])("rejects malformed near-match Composer prefix %j", (prefix) => {
    const source = `${JSON.stringify({
      autoload: {
        "psr-4": {
          [prefix]: "generated/skirout/",
        },
      },
    }, null, 2)}\n`;

    expect(() => ensureComposerPsr4Mapping(source, "Skir", "generated/skirout"))
      .toThrow(MalformedComposerPsr4PrefixError);
  });

  it("preserves whitespace in Composer paths", () => {
    const source = '{"autoload":{"psr-4":{"Skir\\\\":" generated/skirout /"}}}\n';

    expect(ensureComposerPsr4Mapping(source, "Skir", " generated\\skirout "))
      .toEqual({
        changed: false,
        namespace: "Skir\\",
        paths: " generated/skirout /",
        source,
      });
  });

  it("throws a detailed conflict error for an existing different mapping", () => {
    const source = '{"autoload":{"psr-4":{"Skir\\\\":"src/"}}}\n';

    expect(() => ensureComposerPsr4Mapping(source, "Skir", "generated/skirout"))
      .toThrow(ComposerAutoloadConflictError);

    try {
      ensureComposerPsr4Mapping(source, "Skir", "generated/skirout");
    } catch (error) {
      expect(error).toMatchObject({
        namespace: "Skir\\",
        existingPaths: "src/",
        requestedPaths: "generated/skirout/",
      });
    }
  });

  it.each([
    ["{", /invalid composer\.json/i],
    ["[]\n", /root value must be an object/i],
    ['{"autoload":[]}\n', /autoload.*object/i],
    ['{"autoload":{"psr-4":[]}}\n', /psr-4.*object/i],
  ])("rejects invalid Composer structure", (source, message) => {
    expect(() => ensureComposerPsr4Mapping(source, "Skir", "generated/skirout"))
      .toThrow(message);
  });

  it.each([
    ['{"autoload":{"psr-4":{"Skir\\\\":42}}}\n'],
    ['{"autoload":{"psr-4":{"Skir\\\\":[]}}}\n'],
    ['{"autoload":{"psr-4":{"Skir\\\\":["generated/skirout",42]}}}\n'],
  ])("rejects malformed existing mapping shape", (source) => {
    expect(() => ensureComposerPsr4Mapping(source, "Skir", "generated/skirout"))
      .toThrow(/string or (?:non-empty )?array of strings/i);
  });

  it.each([
    ["", /path must not be empty/i],
    ["///", /path must not be empty/i],
    [[], /paths must not be empty/i],
  ])("rejects empty requested path %j", (paths, message) => {
    expect(() => ensureComposerPsr4Mapping("{}\n", "Skir", paths))
      .toThrow(message);
  });

  it("validates the requested namespace", () => {
    expect(() => ensureComposerPsr4Mapping("{}\n", "Skir\\", "generated/skirout"))
      .toThrow(/canonical PHP namespace/i);
  });

  it("preserves tabs, CRLF line endings, and a terminal newline", () => {
    const source = "{\r\n\t\"name\": \"example/project\"\r\n}\r\n";

    const result = ensureComposerPsr4Mapping(source, "Skir", "generated/skirout");

    expect(result.source).toContain("\r\n\t\"autoload\"");
    expect(result.source).not.toMatch(/(^|[^\r])\n/u);
    expect(result.source.endsWith("\r\n")).toBe(true);
  });

  it("preserves the absence of a terminal newline", () => {
    const result = ensureComposerPsr4Mapping('{\n    "name": "example/project"\n}', "Skir", "generated/skirout");

    expect(result.source.endsWith("\n")).toBe(false);
    expect(result.source).toContain('\n    "autoload"');
  });

  it.each([
    ['{\n  // comment\n  "name": "example/project"\n}\n'],
    ['{\n  "name": "example/project",\n}\n'],
  ])("rejects JSONC forms Composer does not accept", (source) => {
    expect(() => ensureComposerPsr4Mapping(source, "Skir", "generated/skirout"))
      .toThrow(/invalid composer\.json/i);
  });
});
