import type {
  CoreGeneratorInput,
  NormalizedField,
  NormalizedMethod,
  NormalizedModule,
  NormalizedRecord,
  NormalizedSchema,
  NormalizedType,
  SkirField,
  SkirMethod,
  SkirModule,
  SkirRecord,
  SkirRecordLocation,
  SkirRecordNamePart,
  SkirToken,
  SkirType,
} from "./model.js";
import { toPhpNamespaceSegment } from "./naming.js";

const NORMALIZED_PRIMITIVES = new Set([
  "bool",
  "int32",
  "int64",
  "hash64",
  "float32",
  "float64",
  "string",
  "bytes",
  "timestamp",
  "mixed",
]);

interface RecordSource {
  readonly module: SkirModule;
  readonly record: SkirRecord;
  readonly location?: SkirRecordLocation;
  readonly identity: string;
  readonly modulePath: string;
  readonly qualifiedName: string;
  readonly recordType: "struct" | "enum";
  readonly key?: string;
}

interface NormalizationContext {
  readonly recordsByIdentity: ReadonlyMap<string, NormalizedRecord>;
  readonly recordsByKey: ReadonlyMap<string, NormalizedRecord>;
  readonly recordMap?: ReadonlyMap<string, SkirRecordLocation>;
  readonly currentModulePath: string;
  readonly description: string;
}

export function normalizeSchema(input: CoreGeneratorInput): NormalizedSchema {
  const moduleShapes = input.modules.map((module) => normalizeModuleShape(module));
  assertDistinctModuleNamespaces(moduleShapes);

  const sourcesByModule = input.modules.map((module) => (
    (module.records ?? []).map((record) => recordSource(module, record))
  ));
  const recordsByIdentity = new Map<string, NormalizedRecord>();
  const recordsByKey = new Map<string, NormalizedRecord>();

  for (const sources of sourcesByModule) {
    for (const source of sources) {
      if (recordsByIdentity.has(source.identity)) {
        throw new Error(`Duplicate normalized record identity ${source.identity}.`);
      }

      if (source.key !== undefined && recordsByKey.has(source.key)) {
        throw new Error(`Duplicate Skir record key "${source.key}".`);
      }

      const normalized: NormalizedRecord = {
        identity: source.identity,
        modulePath: source.modulePath,
        qualifiedName: source.qualifiedName,
        recordType: source.recordType,
        fields: [],
        ...(source.key === undefined ? {} : { key: source.key }),
      };

      recordsByIdentity.set(normalized.identity, normalized);

      if (normalized.key !== undefined) {
        recordsByKey.set(normalized.key, normalized);
      }
    }
  }

  const modules: NormalizedModule[] = [];
  const finalRecordsByIdentity = new Map<string, NormalizedRecord>();
  const finalRecordsByKey = new Map<string, NormalizedRecord>();

  for (let moduleIndex = 0; moduleIndex < input.modules.length; moduleIndex += 1) {
    const module = input.modules[moduleIndex];
    const shape = moduleShapes[moduleIndex];

    if (module === undefined || shape === undefined) {
      throw new Error("Internal module normalization index mismatch.");
    }

    const records = (sourcesByModule[moduleIndex] ?? []).map((source) => {
      const context: NormalizationContext = {
        recordsByIdentity,
        recordsByKey,
        recordMap: input.recordMap,
        currentModulePath: source.modulePath,
        description: `record ${source.identity}`,
      };
      const normalized: NormalizedRecord = {
        identity: source.identity,
        modulePath: source.modulePath,
        qualifiedName: source.qualifiedName,
        recordType: source.recordType,
        fields: normalizeFields(source.record, context),
        ...(source.key === undefined ? {} : { key: source.key }),
      };

      finalRecordsByIdentity.set(normalized.identity, normalized);

      if (normalized.key !== undefined) {
        finalRecordsByKey.set(normalized.key, normalized);
      }

      return normalized;
    });
    const methods = (module.methods ?? []).map((method) => normalizeMethod(method, {
      recordsByIdentity,
      recordsByKey,
      recordMap: input.recordMap,
      currentModulePath: module.path,
      description: `method ${tokenText(method.name)} in ${module.path}`,
    }));

    modules.push({ ...shape, records, methods });
  }

  return {
    modules,
    recordsByIdentity: finalRecordsByIdentity,
    recordsByKey: finalRecordsByKey,
  };
}

function normalizeModuleShape(module: SkirModule): Omit<NormalizedModule, "records" | "methods"> {
  const pathParts = module.path.split("/");
  const sourceDirectory = pathParts.slice(0, -1).join("/");
  const namespaceSegments = pathParts
    .slice(0, -1)
    .map((part) => toPhpNamespaceSegment(part))
    .filter((part) => part !== "");

  return {
    path: module.path,
    sourceDirectory,
    namespaceSegments,
    moduleIdentity: namespaceSegments.length === 0 ? "_Root" : namespaceSegments.join("."),
  };
}

function assertDistinctModuleNamespaces(
  modules: readonly Omit<NormalizedModule, "records" | "methods">[],
): void {
  const sourceDirectoriesByNamespace = new Map<string, string>();

  for (const module of modules) {
    const namespaceKey = module.namespaceSegments.join("\\").toLowerCase();
    const existingSourceDirectory = sourceDirectoriesByNamespace.get(namespaceKey);

    if (existingSourceDirectory === undefined) {
      sourceDirectoriesByNamespace.set(namespaceKey, module.sourceDirectory);
    } else if (existingSourceDirectory !== module.sourceDirectory) {
      throw new Error(
        `Module namespace normalization collision: source directories ${existingSourceDirectory || "<root>"} and ${module.sourceDirectory || "<root>"} produce the same case-insensitive PHP namespace ${module.moduleIdentity}.`,
      );
    }
  }
}

function recordSource(module: SkirModule, input: SkirRecord | SkirRecordLocation): RecordSource {
  const location: SkirRecordLocation | undefined = isRecordLocation(input) ? input : undefined;
  const record: SkirRecord = isRecordLocation(input) ? input.record : input;
  const modulePath = location?.modulePath ?? module.path;
  const qualifiedName = location === undefined
    ? tokenText(record.name)
    : qualifiedNameForLocation(location);
  const recordType = record.recordType
    ?? (record.kind === "struct" || record.kind === "enum" ? record.kind : undefined);

  if (recordType === undefined) {
    throw new Error(`Skir record ${modulePath}::${qualifiedName} has no struct or enum record type.`);
  }

  const key = typeof record.key === "string" ? record.key : undefined;

  return {
    module,
    record,
    location,
    modulePath,
    qualifiedName,
    identity: `${modulePath}::${qualifiedName}`,
    recordType,
    ...(key === undefined ? {} : { key }),
  };
}

function qualifiedNameForLocation(location: SkirRecordLocation): string {
  const ancestors = location.recordAncestors ?? [];

  if (ancestors.length === 0) {
    return tokenText(location.record.name);
  }

  return ancestors.map((ancestor) => tokenText(ancestor.name)).join(".");
}

function normalizeFields(
  record: SkirRecord,
  context: NormalizationContext,
): readonly (NormalizedField | { readonly kind: "removed"; readonly number: number })[] {
  const fields: (NormalizedField | { readonly kind: "removed"; readonly number: number })[] = [];
  const usedNumbers = new Set<number>();

  for (const field of record.fields ?? []) {
    if (usedNumbers.has(field.number)) {
      throw new Error(`Duplicate field or removed number ${field.number} in ${context.description}.`);
    }

    usedNumbers.add(field.number);
    fields.push(normalizeField(field, context));
  }

  for (const number of record.removedNumbers ?? []) {
    if (!usedNumbers.has(number)) {
      usedNumbers.add(number);
      fields.push({ kind: "removed", number });
    }
  }

  return fields.sort((left, right) => left.number - right.number);
}

function normalizeField(
  field: SkirField,
  context: NormalizationContext,
): NormalizedField | { readonly kind: "removed"; readonly number: number } {
  if (field.kind === "removed") {
    return field;
  }

  return {
    kind: "field",
    name: tokenText(field.name),
    number: field.number,
    type: field.type === undefined ? { kind: "mixed" } : normalizeType(field.type, context),
  };
}

function normalizeMethod(method: SkirMethod, context: NormalizationContext): NormalizedMethod {
  return {
    name: tokenText(method.name),
    number: method.number,
    requestType: normalizeType(method.requestType ?? "string", context),
    responseType: normalizeType(method.responseType ?? "string", context),
  };
}

function normalizeType(type: SkirType, context: NormalizationContext): NormalizedType {
  const kind = typeKind(type);

  if (NORMALIZED_PRIMITIVES.has(kind)) {
    return primitiveType(kind);
  }

  if (kind === "array") {
    return { kind: "array", item: normalizeType(arrayItemType(type), context) };
  }

  if (kind === "optional") {
    return { kind: "optional", inner: normalizeType(optionalInnerType(type), context) };
  }

  if (kind === "record") {
    return normalizeRecordType(type, context);
  }

  throw new Error(`Unsupported Skir type kind "${kind}" in ${context.description}.`);
}

function primitiveType(kind: string): NormalizedType {
  if (
    kind === "bool"
    || kind === "int32"
    || kind === "int64"
    || kind === "hash64"
    || kind === "float32"
    || kind === "float64"
    || kind === "string"
    || kind === "bytes"
    || kind === "timestamp"
    || kind === "mixed"
  ) {
    return { kind };
  }

  throw new Error(`Unsupported normalized primitive ${kind}.`);
}

function normalizeRecordType(type: SkirType, context: NormalizationContext): NormalizedType {
  if (typeof type === "string") {
    throw new Error(`String type ${type} cannot be normalized as a record reference.`);
  }

  const key = typeof type.key === "string" ? type.key : undefined;

  if (key !== undefined) {
    if (context.recordMap !== undefined) {
      const location = context.recordMap.get(key);

      if (location === undefined) {
        throw new Error(`Skir record key "${key}" in ${context.description} could not be resolved through recordMap.`);
      }

      const identity = `${location.modulePath ?? context.currentModulePath}::${qualifiedNameForLocation(location)}`;
      const mappedRecord = context.recordsByIdentity.get(identity);

      if (mappedRecord === undefined) {
        throw new Error(`Skir record key "${key}" resolves to ${identity}, which is not present in the normalized modules.`);
      }

      return recordType(mappedRecord, type.recordType, context);
    }

    const localRecord = context.recordsByKey.get(key);

    if (localRecord === undefined) {
      throw new Error(`Skir record key "${key}" in ${context.description} could not be resolved.`);
    }

    return recordType(localRecord, type.recordType, context);
  }

  const referenceName = recordReferenceName(type);
  const matchingRecords = [...context.recordsByIdentity.values()].filter((record) => (
    record.qualifiedName === referenceName
    || record.qualifiedName.split(".").at(-1) === referenceName
  ));
  const localMatches = matchingRecords.filter((record) => record.modulePath === context.currentModulePath);
  const candidates = localMatches.length > 0 ? localMatches : matchingRecords;

  if (candidates.length === 0) {
    throw new Error(`Skir record reference "${referenceName}" in ${context.description} could not be resolved.`);
  }

  if (candidates.length > 1) {
    throw new Error(
      `Skir record reference "${referenceName}" in ${context.description} is ambiguous: ${candidates.map((record) => record.identity).join(", ")}.`,
    );
  }

  const candidate = candidates[0];

  if (candidate === undefined) {
    throw new Error(`Skir record reference "${referenceName}" in ${context.description} could not be resolved.`);
  }

  return recordType(candidate, type.recordType, context);
}

function recordType(
  record: NormalizedRecord,
  expectedRecordType: "struct" | "enum" | undefined,
  context: NormalizationContext,
): NormalizedType {
  if (expectedRecordType !== undefined && expectedRecordType !== record.recordType) {
    throw new Error(
      `Skir record reference to ${record.identity} in ${context.description} expects ${expectedRecordType}, but the record is ${record.recordType}.`,
    );
  }

  return {
    kind: "record",
    recordIdentity: record.identity,
    recordType: record.recordType,
  };
}

function recordReferenceName(type: Exclude<SkirType, string>): string {
  if (type.name !== undefined) {
    return tokenText(type.name);
  }

  if (type.nameParts !== undefined && type.nameParts.length > 0) {
    return type.nameParts.map((part) => recordNamePartText(part)).join(".");
  }

  throw new Error("Skir record reference is missing both a key and a name.");
}

function typeKind(type: SkirType): string {
  if (typeof type === "string") {
    return type;
  }

  return type.kind === "primitive" ? type.primitive ?? "string" : type.kind;
}

function arrayItemType(type: SkirType): SkirType {
  if (typeof type !== "string" && type.kind === "array" && type.item !== undefined) {
    return type.item;
  }

  throw new Error("Skir array type is missing its item type.");
}

function optionalInnerType(type: SkirType): SkirType {
  if (typeof type !== "string" && type.kind === "optional" && type.other !== undefined) {
    return type.other;
  }

  throw new Error("Skir optional type is missing its inner type.");
}

function recordNamePartText(part: SkirRecordNamePart): string {
  if (typeof part === "string") {
    return part;
  }

  if ("token" in part) {
    return tokenText(part.token);
  }

  return tokenText(part);
}

function tokenText(token: string | SkirToken): string {
  return typeof token === "string" ? token : token.text;
}

function isRecordLocation(value: SkirRecord | SkirRecordLocation): value is SkirRecordLocation {
  return value.kind === "record-location" && "record" in value;
}
