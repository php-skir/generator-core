import type { NormalizedRecord, NormalizedSchema } from "./model.js";
import { normalizeModulePath } from "./module-path.js";
import {
  toClassName,
  toPhpNamespaceSegment,
  toPropertyName,
} from "./php-identifier.js";

export {
  toClassName,
  toPhpNamespaceSegment,
  toPropertyName,
} from "./php-identifier.js";

export interface PhpNameRegistry {
  readonly namesByIdentity: ReadonlyMap<string, string>;
  readonly namesByRecordKey: ReadonlyMap<string, string>;
}

interface NameCandidate {
  readonly record: NormalizedRecord;
  readonly namespace: string;
  readonly baseClassName: string;
}

const PHP_CLASS_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildPhpNameRegistry(
  rootNamespace: string,
  schema: NormalizedSchema,
  recordClassName: (record: NormalizedRecord) => string,
): PhpNameRegistry {
  const candidates: NameCandidate[] = [];
  const candidatesByCaseInsensitiveName = new Map<string, NameCandidate>();

  for (const record of schema.recordsByIdentity.values()) {
    const modulePath = normalizeModulePath(record.modulePath);

    const baseClassName = recordClassName(record);
    assertValidPhpClassName(baseClassName, `for record ${record.identity}`);

    const namespace = [rootNamespace, ...modulePath.namespaceSegments]
      .filter((segment) => segment !== "")
      .join("\\");
    const candidate = { record, namespace, baseClassName };
    const caseInsensitiveKey = `${namespace}\\${baseClassName}`.toLowerCase();
    const caseInsensitiveMatch = candidatesByCaseInsensitiveName.get(caseInsensitiveKey);

    if (
      caseInsensitiveMatch !== undefined
      && `${caseInsensitiveMatch.namespace}\\${caseInsensitiveMatch.baseClassName}`
        !== `${namespace}\\${baseClassName}`
    ) {
      throw new Error(
        `Case-insensitive PHP class collision: ${caseInsensitiveMatch.namespace}\\${caseInsensitiveMatch.baseClassName} and ${namespace}\\${baseClassName}.`,
      );
    }

    candidatesByCaseInsensitiveName.set(caseInsensitiveKey, candidate);
    candidates.push(candidate);
  }

  const exactGroups = new Map<string, NameCandidate[]>();

  for (const candidate of candidates) {
    const key = `${candidate.namespace}\\${candidate.baseClassName}`;
    const group = exactGroups.get(key);

    if (group === undefined) {
      exactGroups.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }

  const namesByIdentity = new Map<string, string>();
  const namesByRecordKey = new Map<string, string>();
  const classNamesByIdentity = new Map<string, string>();
  const emittedNames = new Map<string, { readonly identity: string; readonly qualifiedName: string }>();

  for (const group of exactGroups.values()) {
    for (const candidate of group) {
      const className = group.length === 1
        ? candidate.baseClassName
        : `${moduleClassPrefix(candidate.record.modulePath)}${candidate.baseClassName}`;

      classNamesByIdentity.set(candidate.record.identity, className);
    }
  }

  for (const candidate of candidates) {
    const className = classNamesByIdentity.get(candidate.record.identity);

    if (className === undefined) {
      throw new Error(`No PHP class name was resolved for record ${candidate.record.identity}.`);
    }

    assertValidPhpClassName(
      className,
      `after collision prefixing for record ${candidate.record.identity}`,
    );

    const emittedKey = `${candidate.namespace}\\${className}`.toLowerCase();
    const existing = emittedNames.get(emittedKey);

    if (existing !== undefined) {
      throw new Error(
        `PHP class collision after deterministic prefixing: records ${existing.identity} and ${candidate.record.identity} both produce ${candidate.namespace}\\${className}.`,
      );
    }

    emittedNames.set(emittedKey, {
      identity: candidate.record.identity,
      qualifiedName: `${candidate.namespace}\\${className}`,
    });
    namesByIdentity.set(candidate.record.identity, className);
  }

  for (const [key, record] of schema.recordsByKey) {
    const className = namesByIdentity.get(record.identity);

    if (className === undefined) {
      throw new Error(`No PHP class name was resolved for Skir record key "${key}" (${record.identity}).`);
    }

    namesByRecordKey.set(key, className);
  }

  return { namesByIdentity, namesByRecordKey };
}

function moduleClassPrefix(modulePath: string): string {
  const moduleFileName = modulePath.split("/").at(-1) ?? modulePath;

  return toClassName(moduleFileName.replace(/\.skir$/, ""));
}

function assertValidPhpClassName(className: string, context: string): void {
  if (!PHP_CLASS_IDENTIFIER.test(className)) {
    throw new Error(
      `Invalid PHP class name "${className}" ${context}; expected an ASCII identifier starting with a letter or underscore and containing only letters, numbers, and underscores.`,
    );
  }
}
