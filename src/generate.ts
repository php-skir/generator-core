import type { PhpTargetAdapter, RenderContext } from "./adapter.js";
import { createImportRegistry } from "./imports.js";
import type {
  GeneratedFile,
  NormalizedMethod,
  NormalizedModule,
  NormalizedRecord,
  NormalizedSchema,
  NormalizedType,
  SkirModule,
  SkirRecordLocation,
} from "./model.js";
import { normalizeModulePath } from "./module-path.js";
import { normalizeSchema } from "./normalize.js";
import { buildPhpNameRegistry, type PhpNameRegistry, toClassName, toPropertyName } from "./naming.js";
import { renderEnum } from "./render-enum.js";
import { methodEnumClassName, renderRpcFiles } from "./render-rpc.js";
import {
  generateServerManifestFile,
  type ServerManifestMethod,
  type ServerManifestModule,
} from "./server-manifest.js";

export interface GeneratePhpInput {
  readonly namespace: string;
  readonly modules: readonly SkirModule[];
  readonly recordMap?: ReadonlyMap<string, SkirRecordLocation>;
  readonly adapter: PhpTargetAdapter;
}

export interface GenerateNormalizedPhpInput {
  readonly namespace: string;
  readonly schema: NormalizedSchema;
  readonly names: PhpNameRegistry;
  readonly adapter: PhpTargetAdapter;
}

interface MethodGroup {
  readonly module: NormalizedModule;
  readonly methods: NormalizedMethod[];
}

export function generatePhp(input: GeneratePhpInput): GeneratedFile[] {
  const schema = normalizeSchema({
    modules: input.modules,
    ...(input.recordMap === undefined ? {} : { recordMap: input.recordMap }),
  });
  const names = buildPhpNameRegistry(
    input.namespace,
    schema,
    (record) => input.adapter.recordClassName(record),
  );

  input.adapter.prepare?.(schema);

  return generateNormalizedPhp({
    namespace: input.namespace,
    schema,
    names,
    adapter: input.adapter,
  });
}

export function generateNormalizedPhp(input: GenerateNormalizedPhpInput): GeneratedFile[] {
  const plannedImports = generatedRecordClassNames(input.namespace, input.schema, input.names);
  const recordFiles = input.schema.modules.flatMap((module) => (
    module.records.map((record) => renderRecord(
      input,
      module,
      record,
      plannedImports,
    ))
  ));
  const methodGroups = collectMethodGroups(input.schema.modules);
  const rpcFiles = methodGroups.flatMap((group) => renderRpcFiles({
    rootNamespace: input.namespace,
    module: group.module,
    methods: group.methods,
    names: input.names,
    adapter: input.adapter,
    plannedImports: [
      ...plannedImports,
      ...(input.adapter.rpcImports?.(group.methods) ?? []),
    ],
  }));
  const manifest = generateServerManifestFile(
    input.adapter.id,
    methodGroups.map((group) => renderManifestModule(input, group)),
  );
  const files = [...recordFiles, ...rpcFiles, manifest];

  assertDistinctOutputPaths(files);

  return files;
}

function renderRecord(
  input: GenerateNormalizedPhpInput,
  module: NormalizedModule,
  record: NormalizedRecord,
  plannedImports: readonly string[],
): GeneratedFile {
  const className = input.names.namesByIdentity.get(record.identity);

  if (className === undefined) {
    throw new Error(`No PHP class name was resolved for record ${record.identity}.`);
  }

  const targetImports = record.recordType === "struct"
    ? input.adapter.structImports?.(record) ?? []
    : input.adapter.enumImports?.(record) ?? [];

  const context = createRenderContext(
    input,
    module,
    [className],
    [
      ...plannedImports,
      "Skir\\Runtime\\DenseJson",
      "Skir\\Runtime\\EnumValue",
      "Skir\\Runtime\\Field",
      "Skir\\Runtime\\Type",
      "Skir\\Runtime\\Variant",
      ...targetImports,
    ],
  );

  return record.recordType === "enum"
    ? renderEnum(record, context, input.adapter)
    : input.adapter.renderStruct({ record, context });
}

function collectMethodGroups(modules: readonly NormalizedModule[]): readonly MethodGroup[] {
  const groups = new Map<string, MethodGroup>();

  for (const module of modules) {
    if (module.methods.length === 0) {
      continue;
    }

    const key = module.namespaceSegments.join("/").toLowerCase();
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, { module, methods: [...module.methods] });
      continue;
    }

    existing.methods.push(...module.methods);
  }

  return [...groups.values()];
}

function renderManifestModule(
  input: GenerateNormalizedPhpInput,
  group: MethodGroup,
): ServerManifestModule {
  const context = createRenderContext(input, group.module, [], []);

  return {
    name: group.module.moduleIdentity,
    methodEnum: `${context.namespace}\\${methodEnumClassName(group.module)}`,
    methods: group.methods.map((method) => renderManifestMethod(input, context, method)),
  };
}

function renderManifestMethod(
  input: GenerateNormalizedPhpInput,
  context: RenderContext,
  method: NormalizedMethod,
): ServerManifestMethod {
  return {
    name: method.name,
    enumCase: toClassName(method.name),
    phpMethod: toPropertyName(method.name),
    requestType: manifestPhpType(input, context, method.requestType),
    requestClass: manifestRequestClass(input.adapter, context, method.requestType),
    responseType: manifestPhpType(input, context, method.responseType),
    responseClass: manifestResponseClass(input.adapter, context, method.responseType),
  };
}

function manifestPhpType(
  input: GenerateNormalizedPhpInput,
  context: RenderContext,
  type: NormalizedType,
): string {
  if (type.kind === "optional") {
    const innerType = manifestPhpType(input, context, type.inner);

    return nullablePhpType(innerType);
  }

  if (type.kind === "record") {
    return fullyQualifiedRecordClassName(input.namespace, input.schema, input.names, type);
  }

  return input.adapter.manifestPhpType?.(type, context)
    ?? input.adapter.phpType(type, context);
}

function manifestRequestClass(
  adapter: PhpTargetAdapter,
  context: RenderContext,
  type: NormalizedType,
): string | null {
  const objectType = unwrapOptional(type);

  if (objectType.kind !== "record" || objectType.recordType === "enum") {
    return null;
  }

  return adapter.manifestObjectClass(objectType, context);
}

function manifestResponseClass(
  adapter: PhpTargetAdapter,
  context: RenderContext,
  type: NormalizedType,
): string | null {
  const objectType = unwrapOptional(type);

  return objectType.kind === "record"
    ? adapter.manifestObjectClass(objectType, context)
    : null;
}

function unwrapOptional(type: NormalizedType): NormalizedType {
  let innerType = type;

  while (innerType.kind === "optional") {
    innerType = innerType.inner;
  }

  return innerType;
}

function nullablePhpType(type: string): string {
  if (
    type === "mixed"
    || type.startsWith("?")
    || type.split("|").some((member) => member.trim().toLowerCase() === "null")
  ) {
    return type;
  }

  return type.includes("|") ? `${type}|null` : `?${type}`;
}

function createRenderContext(
  input: GenerateNormalizedPhpInput,
  module: NormalizedModule,
  reservedNames: readonly string[],
  plannedImports: readonly string[],
): RenderContext {
  return {
    rootNamespace: input.namespace,
    namespace: [input.namespace, ...module.namespaceSegments]
      .filter((segment) => segment !== "")
      .join("\\"),
    pathPrefix: module.namespaceSegments.join("/"),
    names: input.names,
    imports: createImportRegistry(reservedNames, plannedImports),
  };
}

function generatedRecordClassNames(
  rootNamespace: string,
  schema: NormalizedSchema,
  names: PhpNameRegistry,
): readonly string[] {
  return [...schema.recordsByIdentity.values()].map((record) => {
    const type: NormalizedType = {
      kind: "record",
      recordIdentity: record.identity,
      recordType: record.recordType,
    };

    return fullyQualifiedRecordClassName(rootNamespace, schema, names, type);
  });
}

function fullyQualifiedRecordClassName(
  rootNamespace: string,
  schema: NormalizedSchema,
  names: PhpNameRegistry,
  type: Extract<NormalizedType, { readonly kind: "record" }>,
): string {
  const record = schema.recordsByIdentity.get(type.recordIdentity);

  if (record === undefined) {
    throw new Error(`No normalized record exists for ${type.recordIdentity}.`);
  }

  const modulePath = normalizeModulePath(record.modulePath);

  const className = names.namesByIdentity.get(record.identity);

  if (className === undefined) {
    throw new Error(`No PHP class name was resolved for record ${record.identity}.`);
  }

  return [rootNamespace, ...modulePath.namespaceSegments, className]
    .filter((segment) => segment !== "")
    .join("\\");
}

function assertDistinctOutputPaths(files: readonly GeneratedFile[]): void {
  const outputIndexesByPath = new Map<string, number>();

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];

    if (file === undefined) {
      throw new Error(`Generated output ${index} is missing.`);
    }

    const previousIndex = outputIndexesByPath.get(file.path);

    if (previousIndex !== undefined) {
      throw new Error(
        `Duplicate generated output path "${file.path}" from outputs ${previousIndex + 1} and ${index + 1}.`,
      );
    }

    outputIndexesByPath.set(file.path, index);
  }
}
