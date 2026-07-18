import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";

import { PhpNamespace } from "./config.js";

export type ComposerAutoloadPaths = string | readonly string[];

export interface ComposerPsr4MappingResult {
  readonly changed: boolean;
  readonly namespace: string;
  readonly paths: ComposerAutoloadPaths;
  readonly source: string;
}

export class ComposerAutoloadConflictError extends Error {
  constructor(
    readonly namespace: string,
    readonly existingPaths: ComposerAutoloadPaths,
    readonly requestedPaths: ComposerAutoloadPaths,
  ) {
    super(
      `Composer autoload conflict for ${namespace}: existing mapping ${JSON.stringify(existingPaths)} does not match requested mapping ${JSON.stringify(requestedPaths)}.`,
    );
    this.name = "ComposerAutoloadConflictError";
  }
}

export class MalformedComposerPsr4PrefixError extends Error {
  constructor(
    readonly prefix: string,
    readonly namespace: string,
  ) {
    super(
      `Malformed Composer PSR-4 prefix ${JSON.stringify(prefix)} conflicts with canonical prefix ${JSON.stringify(namespace)}.`,
    );
    this.name = "MalformedComposerPsr4PrefixError";
  }
}

export function ensureComposerPsr4Mapping(
  source: string,
  namespace: string,
  paths: ComposerAutoloadPaths,
): ComposerPsr4MappingResult {
  const normalizedNamespace = normalizeNamespace(namespace);
  const normalizedPaths = normalizePaths(paths);
  const composer = parseComposerJson(source);
  const autoload = optionalObjectProperty(composer, "autoload", "composer.json autoload must be an object.");
  const psr4 = autoload === undefined
    ? undefined
    : optionalObjectProperty(autoload, "psr-4", "composer.json autoload.psr-4 must be an object.");
  const malformedPrefix = Object.keys(psr4 ?? {}).find((prefix) => {
    return prefix !== normalizedNamespace
      && normalizeNamespaceForComparison(prefix) === normalizedNamespace;
  });

  if (malformedPrefix !== undefined) {
    throw new MalformedComposerPsr4PrefixError(malformedPrefix, normalizedNamespace);
  }

  const existingEntry = Object.entries(psr4 ?? {})
    .find(([prefix]) => prefix === normalizedNamespace);

  if (existingEntry !== undefined) {
    const existingPaths = normalizeExistingPaths(existingEntry[1], normalizedNamespace);

    if (pathsAreEquivalent(existingPaths, normalizedPaths)) {
      return {
        changed: false,
        namespace: normalizedNamespace,
        paths: normalizedPaths,
        source,
      };
    }

    throw new ComposerAutoloadConflictError(
      normalizedNamespace,
      existingPaths,
      normalizedPaths,
    );
  }

  const edits = modify(
    source,
    ["autoload", "psr-4", normalizedNamespace],
    normalizedPaths,
    { formattingOptions: detectFormatting(source) },
  );

  return {
    changed: true,
    namespace: normalizedNamespace,
    paths: normalizedPaths,
    source: applyEdits(source, edits),
  };
}

function parseComposerJson(source: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });

  if (errors.length > 0) {
    throw new Error("Invalid composer.json: expected valid JSON.");
  }

  if (!isObject(parsed)) {
    throw new Error("Invalid composer.json: the root value must be an object.");
  }

  return parsed;
}

function optionalObjectProperty(
  object: Record<string, unknown>,
  property: string,
  errorMessage: string,
): Record<string, unknown> | undefined {
  const value = object[property];

  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new Error(errorMessage);
  }

  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNamespace(namespace: string): string {
  return `${PhpNamespace.parse(namespace)}\\`;
}

function normalizeNamespaceForComparison(namespace: string): string | undefined {
  const normalized = namespace.trim()
    .replaceAll("/", "\\")
    .replace(/^\\+/u, "")
    .replace(/\\+$/u, "");

  return normalized.length === 0 ? undefined : `${normalized}\\`;
}

function normalizePaths(paths: ComposerAutoloadPaths): ComposerAutoloadPaths {
  if (typeof paths === "string") {
    return normalizePath(paths);
  }

  if (paths.length === 0) {
    throw new Error("Composer PSR-4 paths must not be empty.");
  }

  return paths.map(normalizePath);
}

function normalizeExistingPaths(value: unknown, namespace: string): ComposerAutoloadPaths {
  if (typeof value === "string") {
    return normalizePath(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0 || !value.every((path): path is string => typeof path === "string")) {
      throw new Error(`Invalid Composer PSR-4 mapping for ${namespace}: expected a string or non-empty array of strings.`);
    }

    return value.map(normalizePath);
  }

  throw new Error(`Invalid Composer PSR-4 mapping for ${namespace}: expected a string or array of strings.`);
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/")
    .replace(/^(\.\/)+/u, "")
    .replace(/\/+$/u, "");

  if (normalized.length === 0) {
    throw new Error("Composer PSR-4 path must not be empty.");
  }

  return `${normalized}/`;
}

function pathsAreEquivalent(first: ComposerAutoloadPaths, second: ComposerAutoloadPaths): boolean {
  const firstPaths = typeof first === "string" ? [first] : first;
  const secondPaths = typeof second === "string" ? [second] : second;

  return firstPaths.length === secondPaths.length
    && firstPaths.every((path, index) => path === secondPaths[index]);
}

function detectFormatting(source: string): FormattingOptions {
  const endOfLine = source.includes("\r\n") ? "\r\n" : "\n";
  const propertyIndent = source.match(/(?:\r?\n)([\t ]+)"/u)?.[1];

  if (propertyIndent?.includes("\t")) {
    return {
      eol: endOfLine,
      insertSpaces: false,
      tabSize: 1,
    };
  }

  return {
    eol: endOfLine,
    insertSpaces: true,
    tabSize: propertyIndent?.length ?? 2,
  };
}
