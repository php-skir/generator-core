import { describe, expect, it } from "vitest";

import {
  buildPhpNameRegistry,
  generatePhp,
  generateNormalizedPhp,
  importClass,
  normalizeSchema,
  toClassName,
  toPhpNamespaceSegment,
  type GeneratedFile,
  type NormalizedRecord,
  type NormalizedSchema,
  type NormalizedType,
  type PhpTargetAdapter,
  type RenderContext,
  type SkirModule,
  type StructRenderRequest,
} from "../src/index.js";

class RecordingAdapter implements PhpTargetAdapter {
  public readonly id = "neutral-adapter";

  public readonly calls: string[] = [];

  public prepare(schema: NormalizedSchema): void {
    this.calls.push(`prepare:${schema.modules.length}`);
  }

  public recordClassName(record: NormalizedRecord): string {
    this.calls.push(`class:${record.identity}`);

    return `${toClassName(record.qualifiedName.replaceAll(".", "_"))}Object`;
  }

  public renderStruct({ record, context }: StructRenderRequest): GeneratedFile {
    this.calls.push(`struct:${record.identity}`);

    return {
      path: pathFor(context, `${classNameFor(record, context)}.php`),
      code: `struct ${record.identity} in ${context.namespace}\n`,
    };
  }

  public phpType(type: NormalizedType, context: RenderContext): string {
    this.calls.push(`type:${type.kind}`);

    if (type.kind === "record") {
      return importedRecordClass(type, context);
    }

    if (type.kind === "optional") {
      return `?${this.phpType(type.inner, context)}`;
    }

    if (type.kind === "array") {
      return "array";
    }

    if (type.kind === "timestamp" || type.kind === "int32") {
      return "int";
    }

    return type.kind === "string" ? "string" : "mixed";
  }

  public toSkirExpression(
    type: NormalizedType,
    expression: string,
    _context: RenderContext,
  ): string {
    this.calls.push(`to:${type.kind}`);

    return `to_skir(${expression})`;
  }

  public fromSkirExpression(
    type: NormalizedType,
    expression: string,
    _context: RenderContext,
  ): string {
    this.calls.push(`from:${type.kind}`);

    return `from_skir(${expression})`;
  }

  public clientResponseExpression(
    type: NormalizedType,
    expression: string,
    _context: RenderContext,
  ): string {
    this.calls.push(`client:${type.kind}`);

    return `client_value(${expression})`;
  }

  public manifestObjectClass(type: NormalizedType, context: RenderContext): string | null {
    this.calls.push(`manifest:${type.kind}`);

    if (type.kind !== "record") {
      return null;
    }

    const className = context.names.namesByIdentity.get(type.recordIdentity);

    if (className === undefined) {
      throw new Error(`Missing neutral manifest class for ${type.recordIdentity}.`);
    }

    const modulePath = type.recordIdentity.split("::", 1)[0] ?? "";
    const namespaceSegments = modulePath
      .split("/")
      .slice(0, -1)
      .map((segment) => toPhpNamespaceSegment(segment))
      .filter((segment) => segment !== "");

    return [context.rootNamespace, ...namespaceSegments, className].join("\\");
  }
}

const addressReference = {
  kind: "record",
  key: "address-key",
  recordType: "struct" as const,
};
const userReference = {
  kind: "record",
  key: "user-key",
  recordType: "struct" as const,
};
const statusReference = {
  kind: "record",
  key: "status-key",
  recordType: "enum" as const,
};

const producerModules: readonly SkirModule[] = [
  {
    path: "common/types.skir",
    records: [{
      kind: "record",
      key: "address-key",
      name: "Address",
      recordType: "struct",
      fields: [{ kind: "field", name: "street", number: 1, type: "string" }],
    }],
  },
  {
    path: "admin/users.skir",
    records: [
      {
        kind: "record",
        key: "user-key",
        name: "User",
        recordType: "struct",
        fields: [{ kind: "field", name: "address", number: 1, type: addressReference }],
      },
      {
        kind: "record",
        key: "status-key",
        name: "Status",
        recordType: "enum",
        fields: [
          { kind: "field", name: "ready", number: 1 },
          { kind: "field", name: "expires_at", number: 2, type: "timestamp" },
        ],
      },
    ],
    methods: [
      {
        kind: "method",
        name: "GetUser",
        number: 10,
        requestType: userReference,
        responseType: addressReference,
      },
      {
        kind: "method",
        name: "SetStatus",
        number: 11,
        requestType: statusReference,
        responseType: "timestamp",
      },
    ],
  },
];

describe("generatePhp", () => {
  it("renders records, grouped RPC artifacts, and a terminal manifest deterministically", () => {
    const firstAdapter = new RecordingAdapter();
    const secondAdapter = new RecordingAdapter();
    const first = generatePhp({
      namespace: "Neutral",
      modules: producerModules,
      adapter: firstAdapter,
    });
    const second = generatePhp({
      namespace: "Neutral",
      modules: producerModules,
      adapter: secondAdapter,
    });

    expect(first).toEqual(second);
    expect(first.map((file) => file.path)).toEqual([
      "Common/AddressObject.php",
      "Admin/UserObject.php",
      "Admin/StatusObject.php",
      "Admin/SkirMethods.php",
      "Admin/AdminSkirMethod.php",
      "Admin/SkirRpcClient.php",
      "Admin/SkirProcedures.php",
      "Admin/AbstractSkirProcedures.php",
      "Admin/SkirProcedureProvider.php",
      "skir-server-manifest.json",
    ]);
    expect(firstAdapter.calls.filter((call) => call.startsWith("prepare:"))).toEqual([
      "prepare:2",
    ]);
    expect(firstAdapter.calls.indexOf("prepare:2"))
      .toBeLessThan(firstAdapter.calls.findIndex((call) => call.startsWith("struct:")));
    expect(firstAdapter.calls.filter((call) => call.startsWith("struct:"))).toEqual([
      "struct:common/types.skir::Address",
      "struct:admin/users.skir::User",
    ]);
    expect(firstAdapter.calls).toEqual(expect.arrayContaining([
      "type:timestamp",
      "to:record",
      "from:record",
      "client:record",
      "manifest:record",
    ]));

    const enumFile = first.find((file) => file.path === "Admin/StatusObject.php");

    expect(enumFile?.code).toContain("public static function ready(): self");
    expect(enumFile?.code).toContain("EnumValue::constant('ready')");
    expect(enumFile?.code).toContain("public static function expiresAt(int $value): self");
    expect(enumFile?.code).toContain("Variant::wrapper('expires_at', 2, Type::timestamp())");

    const rpcFiles = first.filter((file) => file.path.startsWith("Admin/"))
      .filter((file) => file.path.includes("Skir"));

    expect(rpcFiles).toHaveLength(6);
    expect(first.filter((file) => file.path.startsWith("Common/Skir"))).toHaveLength(0);

    const manifestFile = first.at(-1);

    expect(manifestFile?.path).toBe("skir-server-manifest.json");
    expect(JSON.parse(manifestFile?.code ?? "")).toMatchObject({
      version: 1,
      generator: "neutral-adapter",
      modules: [{
        name: "Admin",
        methodEnum: "Neutral\\Admin\\AdminSkirMethod",
        methods: [{
          name: "GetUser",
          requestClass: "Neutral\\Admin\\UserObject",
          responseClass: "Neutral\\Common\\AddressObject",
        }, {
          name: "SetStatus",
          requestClass: null,
          responseClass: null,
        }],
      }],
    });
  });

  it("renders an already normalized schema with its supplied name registry", () => {
    const schema = normalizeSchema({ modules: producerModules });
    const adapter = new RecordingAdapter();
    const names = buildPhpNameRegistry(
      "Neutral",
      schema,
      (record) => adapter.recordClassName(record),
    );

    const files = generateNormalizedPhp({
      namespace: "Neutral",
      schema,
      names,
      adapter,
    });

    expect(files.map((file) => file.path)).toEqual([
      "Common/AddressObject.php",
      "Admin/UserObject.php",
      "Admin/StatusObject.php",
      "Admin/SkirMethods.php",
      "Admin/AdminSkirMethod.php",
      "Admin/SkirRpcClient.php",
      "Admin/SkirProcedures.php",
      "Admin/AbstractSkirProcedures.php",
      "Admin/SkirProcedureProvider.php",
      "skir-server-manifest.json",
    ]);
    expect(adapter.calls.filter((call) => call.startsWith("prepare:"))).toEqual([]);
  });

  it("returns only a terminal manifest for an empty schema", () => {
    const files = generatePhp({
      namespace: "Neutral",
      modules: [],
      adapter: new RecordingAdapter(),
    });

    expect(files).toEqual([{
      path: "skir-server-manifest.json",
      code: "{\n  \"version\": 1,\n  \"generator\": \"neutral-adapter\",\n  \"modules\": []\n}\n",
    }]);
  });

  it("rejects duplicate generated output paths with the colliding path", () => {
    class DuplicatePathAdapter extends RecordingAdapter {
      public override renderStruct({ record }: StructRenderRequest): GeneratedFile {
        this.calls.push(`struct:${record.identity}`);

        return { path: "Duplicate.php", code: record.identity };
      }
    }

    expect(() => generatePhp({
      namespace: "Neutral",
      modules: producerModules,
      adapter: new DuplicatePathAdapter(),
    })).toThrow(/duplicate generated output path "Duplicate\.php"/i);
  });
});

function classNameFor(record: NormalizedRecord, context: RenderContext): string {
  const className = context.names.namesByIdentity.get(record.identity);

  if (className === undefined) {
    throw new Error(`Missing neutral class for ${record.identity}.`);
  }

  return className;
}

function importedRecordClass(type: Extract<NormalizedType, { readonly kind: "record" }>, context: RenderContext): string {
  const className = context.names.namesByIdentity.get(type.recordIdentity);

  if (className === undefined) {
    throw new Error(`Missing neutral type class for ${type.recordIdentity}.`);
  }

  const modulePath = type.recordIdentity.split("::", 1)[0] ?? "";
  const namespaceSegments = modulePath
    .split("/")
    .slice(0, -1)
    .map((segment) => toPhpNamespaceSegment(segment))
    .filter((segment) => segment !== "");
  const namespace = [context.rootNamespace, ...namespaceSegments].join("\\");

  return namespace === context.namespace
    ? className
    : importClass(context.imports, `${namespace}\\${className}`);
}

function pathFor(context: RenderContext, fileName: string): string {
  return context.pathPrefix === "" ? fileName : `${context.pathPrefix}/${fileName}`;
}
