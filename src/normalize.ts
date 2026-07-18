import type {
  CoreGeneratorInput,
  NormalizedEnumConstant,
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
import { normalizeModulePath } from "./module-path.js";

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
  readonly record: SkirRecord;
  readonly identity: string;
  readonly modulePath: string;
  readonly qualifiedName: string;
  readonly recordType: "struct" | "enum";
  readonly key?: string;
  readonly phpClassName?: string;
}

interface NormalizationContext {
  readonly recordsByIdentity: ReadonlyMap<string, NormalizedRecord>;
  readonly recordsByKey: ReadonlyMap<string, NormalizedRecord>;
  readonly currentModulePath: string;
  readonly description: string;
}

export function normalizeSchema(input: CoreGeneratorInput): NormalizedSchema {
  const moduleShapes = input.modules.map((module) => normalizeModulePath(module.path));
  assertDistinctModuleNamespaces(moduleShapes);

  const sourcesByModule = input.modules.map((module) => (
    (module.records ?? []).map((record) => recordSource(module, record))
  ));
  const recordsByIdentity = new Map<string, NormalizedRecord>();
  const recordIdentitiesByKey = new Map<string, string>();
  const recordIdentitiesByObject = new Map<SkirRecord, string>();

  for (const sources of sourcesByModule) {
    for (const source of sources) {
      if (recordsByIdentity.has(source.identity)) {
        throw new Error(`Duplicate normalized record identity ${source.identity}.`);
      }

      assertConsistentRecordObjectLocation(recordIdentitiesByObject, source);

      const normalized: NormalizedRecord = {
        identity: source.identity,
        modulePath: source.modulePath,
        qualifiedName: source.qualifiedName,
        recordType: source.recordType,
        fields: [],
        ...(source.key === undefined ? {} : { key: source.key }),
        ...(source.phpClassName === undefined ? {} : { phpClassName: source.phpClassName }),
      };

      recordsByIdentity.set(normalized.identity, normalized);

      if (normalized.key !== undefined) {
        bindRecordKey(recordIdentitiesByKey, normalized.key, normalized.identity, "module record");
      }
    }
  }

  const generatedSources = sourcesByModule.flat();
  const recordMapEntries = [...(input.recordMap?.entries() ?? [])]
    .sort(([leftKey], [rightKey]) => leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0);

  for (const [mapKey, location] of recordMapEntries) {
    const source = recordMapSource(mapKey, location, generatedSources);
    const existing = recordsByIdentity.get(source.identity);

    assertConsistentRecordObjectLocation(recordIdentitiesByObject, source);

    if (existing === undefined) {
      recordsByIdentity.set(source.identity, {
        identity: source.identity,
        modulePath: source.modulePath,
        qualifiedName: source.qualifiedName,
        recordType: source.recordType,
        fields: [],
        key: mapKey,
        ...(source.phpClassName === undefined ? {} : { phpClassName: source.phpClassName }),
      });
    } else if (existing.recordType !== source.recordType) {
      throw new Error(
        `Record map location for key "${mapKey}" resolves to ${source.identity}, whose normalized record is ${existing.recordType}, but the location record is ${source.recordType}.`,
      );
    } else {
      assertCompatiblePhpClassName(
        existing,
        source,
        `Record map location for key "${mapKey}"`,
      );

      if (existing.phpClassName === undefined && source.phpClassName !== undefined) {
        recordsByIdentity.set(source.identity, {
          ...existing,
          phpClassName: source.phpClassName,
        });
      }
    }

    bindRecordKey(recordIdentitiesByKey, mapKey, source.identity, "recordMap location");
  }

  const recordsByKey = recordsForKeys(recordIdentitiesByKey, recordsByIdentity);

  const modules: NormalizedModule[] = [];
  const finalRecordsByIdentity = new Map(recordsByIdentity);

  for (let moduleIndex = 0; moduleIndex < input.modules.length; moduleIndex += 1) {
    const module = input.modules[moduleIndex];
    const shape = moduleShapes[moduleIndex];

    if (module === undefined || shape === undefined) {
      throw new Error("Internal module normalization index mismatch.");
    }

    const records = (sourcesByModule[moduleIndex] ?? []).map((source) => {
      const indexedRecord = recordsByIdentity.get(source.identity);

      if (indexedRecord === undefined) {
        throw new Error(`No indexed normalized record exists for ${source.identity}.`);
      }

      assertCompatiblePhpClassName(indexedRecord, source, "Generated record");

      const context: NormalizationContext = {
        recordsByIdentity,
        recordsByKey,
        currentModulePath: source.modulePath,
        description: `record ${source.identity}`,
      };
      const phpClassName = source.phpClassName ?? indexedRecord.phpClassName;
      const normalized: NormalizedRecord = {
        identity: source.identity,
        modulePath: source.modulePath,
        qualifiedName: source.qualifiedName,
        recordType: source.recordType,
        fields: normalizeFields(source.record, source.recordType, context),
        ...(source.key === undefined ? {} : { key: source.key }),
        ...(phpClassName === undefined ? {} : { phpClassName }),
      };

      finalRecordsByIdentity.set(normalized.identity, normalized);

      return normalized;
    });
    const methods = (module.methods ?? []).map((method) => normalizeMethod(method, {
      recordsByIdentity,
      recordsByKey,
      currentModulePath: module.path,
      description: `method ${tokenText(method.name)} in ${module.path}`,
    }));

    modules.push({ ...shape, records, methods });
  }

  const finalRecordsByKey = recordsForKeys(recordIdentitiesByKey, finalRecordsByIdentity);

  return {
    modules,
    recordsByIdentity: finalRecordsByIdentity,
    recordsByKey: finalRecordsByKey,
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
        `Module namespace normalization collision: ${module.moduleIdentity} is produced by source directories ${existingSourceDirectory || "<root>"} and ${module.sourceDirectory || "<root>"}.`,
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
  const recordType = recordTypeFor(record, `${modulePath}::${qualifiedName}`);

  const key = typeof record.key === "string" ? record.key : undefined;

  return {
    record,
    modulePath,
    qualifiedName,
    identity: `${modulePath}::${qualifiedName}`,
    recordType,
    ...(key === undefined ? {} : { key }),
    ...(record.phpClassName === undefined ? {} : { phpClassName: record.phpClassName }),
  };
}

function recordTypeFor(record: SkirRecord, identity: string): "struct" | "enum" {
  const recordType = record.recordType
    ?? (record.kind === "struct" || record.kind === "enum" ? record.kind : undefined);

  if (recordType === undefined) {
    throw new Error(`Skir record ${identity} has no struct or enum record type.`);
  }

  return recordType;
}

function recordMapSource(
  mapKey: string,
  location: SkirRecordLocation,
  generatedSources: readonly RecordSource[],
): RecordSource {
  let modulePath = location.modulePath;

  if (modulePath === undefined) {
    const matchingSources = generatedSources.filter((source) => source.record === location.record);

    if (matchingSources.length !== 1) {
      throw new Error(
        `Record map location for key "${mapKey}" has no module path and cannot be associated with exactly one generated record.`,
      );
    }

    modulePath = matchingSources[0]?.modulePath;
  }

  if (modulePath === undefined) {
    throw new Error(`Record map location for key "${mapKey}" has no module path.`);
  }

  const qualifiedName = qualifiedNameForLocation(location);
  const recordType = recordTypeFor(location.record, `${modulePath}::${qualifiedName}`);

  return {
    record: location.record,
    modulePath,
    qualifiedName,
    identity: `${modulePath}::${qualifiedName}`,
    recordType,
    ...(location.record.phpClassName === undefined
      ? {}
      : { phpClassName: location.record.phpClassName }),
  };
}

function assertCompatiblePhpClassName(
  existing: NormalizedRecord,
  source: RecordSource,
  sourceDescription: string,
): void {
  if (
    existing.phpClassName !== undefined
    && source.phpClassName !== undefined
    && existing.phpClassName !== source.phpClassName
  ) {
    throw new Error(
      `${sourceDescription} resolves to ${source.identity} with incompatible PHP class names "${existing.phpClassName}" and "${source.phpClassName}".`,
    );
  }
}

function assertConsistentRecordObjectLocation(
  recordIdentitiesByObject: Map<SkirRecord, string>,
  source: RecordSource,
): void {
  const existingIdentity = recordIdentitiesByObject.get(source.record);

  if (existingIdentity !== undefined && existingIdentity !== source.identity) {
    throw new Error(
      `Conflicting record locations for the same Skir record: ${existingIdentity} and ${source.identity}.`,
    );
  }

  recordIdentitiesByObject.set(source.record, source.identity);
}

function bindRecordKey(
  recordIdentitiesByKey: Map<string, string>,
  key: string,
  identity: string,
  sourceDescription: string,
): void {
  const existingIdentity = recordIdentitiesByKey.get(key);

  if (existingIdentity !== undefined && existingIdentity !== identity) {
    throw new Error(
      `Skir record key "${key}" resolves to both ${existingIdentity} and ${identity} through ${sourceDescription}.`,
    );
  }

  recordIdentitiesByKey.set(key, identity);
}

function recordsForKeys(
  recordIdentitiesByKey: ReadonlyMap<string, string>,
  recordsByIdentity: ReadonlyMap<string, NormalizedRecord>,
): Map<string, NormalizedRecord> {
  const recordsByKey = new Map<string, NormalizedRecord>();

  for (const [key, identity] of recordIdentitiesByKey) {
    const record = recordsByIdentity.get(identity);

    if (record === undefined) {
      throw new Error(`No normalized record exists for Skir record key "${key}" (${identity}).`);
    }

    recordsByKey.set(key, record);
  }

  return recordsByKey;
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
  recordType: "struct" | "enum",
  context: NormalizationContext,
): readonly (
  | NormalizedField
  | NormalizedEnumConstant
  | { readonly kind: "removed"; readonly number: number }
)[] {
  const fields: (
    | NormalizedField
    | NormalizedEnumConstant
    | { readonly kind: "removed"; readonly number: number }
  )[] = [];
  const usedNumbers = new Set<number>();

  for (const field of record.fields ?? []) {
    if (usedNumbers.has(field.number)) {
      throw new Error(`Duplicate field or removed number ${field.number} in ${context.description}.`);
    }

    usedNumbers.add(field.number);
    fields.push(normalizeField(field, recordType, context));
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
  recordType: "struct" | "enum",
  context: NormalizationContext,
): NormalizedField | NormalizedEnumConstant | { readonly kind: "removed"; readonly number: number } {
  if (field.kind === "removed") {
    return field;
  }

  const name = tokenText(field.name);

  if (field.type === undefined) {
    if (recordType === "enum") {
      return {
        kind: "field",
        name,
        number: field.number,
        hasPayload: false,
      };
    }

    throw new Error(`Struct field "${name}" in ${context.description} is missing its resolved type.`);
  }

  return {
    kind: "field",
    name,
    number: field.number,
    hasPayload: true,
    type: normalizeType(field.type, context),
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
