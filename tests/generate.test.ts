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
    const methodsFile = first.find((file) => file.path === "Admin/SkirMethods.php");

    expect(rpcFiles).toHaveLength(6);
    expect(first.filter((file) => file.path.startsWith("Common/Skir"))).toHaveLength(0);
    expect(methodsFile?.code).toContain("use Skir\\Runtime\\Type;");
    expect(methodsFile?.code).toContain("responseType: Type::timestamp(),");

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

  it("resolves external record locations in RPC output without emitting their record files", () => {
    const addressRecord = {
      kind: "record",
      recordType: "struct" as const,
      name: "Address",
      fields: [],
    };
    const files = generatePhp({
      namespace: "App\\Skir",
      recordMap: new Map([["common/address.skir:0", {
        kind: "record-location",
        record: addressRecord,
        recordAncestors: [addressRecord],
        modulePath: "common/address.skir",
      }]]),
      modules: [{
        path: "admin/users.skir",
        methods: [{
          kind: "method",
          name: "ResolveAddress",
          number: 1,
          requestType: {
            kind: "record",
            key: "common/address.skir:0",
            nameParts: [{ token: { text: "Address" } }],
          },
          responseType: "bool",
        }],
      }],
      adapter: new RecordingAdapter(),
    });
    const methodsFile = files.find((file) => file.path === "Admin/SkirMethods.php");
    const clientFile = files.find((file) => file.path === "Admin/SkirRpcClient.php");
    const manifestFile = files.find((file) => file.path === "skir-server-manifest.json");

    expect(files.some((file) => file.path === "Common/AddressObject.php")).toBe(false);
    expect(methodsFile?.code).toContain("use App\\Skir\\Common\\AddressObject;");
    expect(clientFile?.code).toContain("use App\\Skir\\Common\\AddressObject;");
    expect(JSON.parse(manifestFile?.code ?? "")).toMatchObject({
      modules: [{
        methods: [{
          requestType: "App\\Skir\\Common\\AddressObject",
          requestClass: "App\\Skir\\Common\\AddressObject",
        }],
      }],
    });
  });

  it("renders recursively nullable manifest types and object classes as valid schema-1 JSON", () => {
    class NullableManifestAdapter extends RecordingAdapter {
      public override phpType(type: NormalizedType, context: RenderContext): string {
        if (type.kind === "int64") {
          return "int|string";
        }

        if (type.kind === "hash64") {
          return "int|string|null";
        }

        return super.phpType(type, context);
      }
    }

    const nestedOptional = (other: NormalizedType | string): {
      readonly kind: "optional";
      readonly other: {
        readonly kind: "optional";
        readonly other: NormalizedType | string;
      };
    } => ({
      kind: "optional",
      other: { kind: "optional", other },
    });
    const payloadReference = {
      kind: "record",
      key: "payload-key",
      recordType: "struct" as const,
    };
    const stateReference = {
      kind: "record",
      key: "state-key",
      recordType: "enum" as const,
    };
    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "rpc/api.skir",
        records: [{
          kind: "record",
          key: "payload-key",
          name: "Payload",
          recordType: "struct",
          fields: [],
        }, {
          kind: "record",
          key: "state-key",
          name: "State",
          recordType: "enum",
          fields: [],
        }],
        methods: [{
          kind: "method",
          name: "OptionalMixed",
          number: 1,
          requestType: { kind: "optional", other: "mixed" },
          responseType: { kind: "optional", other: "mixed" },
        }, {
          kind: "method",
          name: "OptionalUnions",
          number: 2,
          requestType: { kind: "optional", other: "int64" },
          responseType: nestedOptional("hash64"),
        }, {
          kind: "method",
          name: "NestedStringAndArray",
          number: 3,
          requestType: nestedOptional("string"),
          responseType: nestedOptional({ kind: "array", item: { kind: "string" } }),
        }, {
          kind: "method",
          name: "NestedStruct",
          number: 4,
          requestType: nestedOptional(payloadReference),
          responseType: nestedOptional(payloadReference),
        }, {
          kind: "method",
          name: "NestedEnum",
          number: 5,
          requestType: nestedOptional(stateReference),
          responseType: nestedOptional(stateReference),
        }],
      }],
      adapter: new NullableManifestAdapter(),
    });
    const manifestCode = files.find((file) => file.path === "skir-server-manifest.json")?.code ?? "";

    expect(JSON.parse(manifestCode)).toEqual({
      version: 1,
      generator: "neutral-adapter",
      modules: [{
        name: "Rpc",
        methodEnum: "Neutral\\Rpc\\RpcSkirMethod",
        methods: [{
          name: "OptionalMixed",
          enumCase: "OptionalMixed",
          phpMethod: "optionalMixed",
          requestType: "mixed",
          requestClass: null,
          responseType: "mixed",
          responseClass: null,
        }, {
          name: "OptionalUnions",
          enumCase: "OptionalUnions",
          phpMethod: "optionalUnions",
          requestType: "int|string|null",
          requestClass: null,
          responseType: "int|string|null",
          responseClass: null,
        }, {
          name: "NestedStringAndArray",
          enumCase: "NestedStringAndArray",
          phpMethod: "nestedStringAndArray",
          requestType: "?string",
          requestClass: null,
          responseType: "?array",
          responseClass: null,
        }, {
          name: "NestedStruct",
          enumCase: "NestedStruct",
          phpMethod: "nestedStruct",
          requestType: "?Neutral\\Rpc\\PayloadObject",
          requestClass: "Neutral\\Rpc\\PayloadObject",
          responseType: "?Neutral\\Rpc\\PayloadObject",
          responseClass: "Neutral\\Rpc\\PayloadObject",
        }, {
          name: "NestedEnum",
          enumCase: "NestedEnum",
          phpMethod: "nestedEnum",
          requestType: "?Neutral\\Rpc\\StateObject",
          requestClass: null,
          responseType: "?Neutral\\Rpc\\StateObject",
          responseClass: "Neutral\\Rpc\\StateObject",
        }],
      }],
    });
    expect(manifestCode).not.toMatch(/\?mixed|\?\?|null\|null|\|null\|null/);
  });

  it("renders enum runtime imports before sorted cross-module payload imports", () => {
    const addressReference = {
      kind: "record",
      key: "address-key",
      recordType: "struct" as const,
    };
    const accountReference = {
      kind: "record",
      key: "account-key",
      recordType: "struct" as const,
    };
    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "models/payloads.skir",
        records: [{
          kind: "record",
          key: "address-key",
          name: "Address",
          recordType: "struct",
          fields: [],
        }, {
          kind: "record",
          key: "account-key",
          name: "Account",
          recordType: "struct",
          fields: [],
        }],
      }, {
        path: "events/status.skir",
        records: [{
          kind: "record",
          key: "status-key",
          name: "Status",
          recordType: "enum",
          fields: [{
            kind: "field",
            name: "address_changed",
            number: 1,
            type: addressReference,
          }, {
            kind: "field",
            name: "account_changed",
            number: 2,
            type: accountReference,
          }],
        }],
      }],
      adapter: new RecordingAdapter(),
    });
    const enumFile = files.find((file) => file.path === "Events/StatusObject.php");

    expect(useStatements(enumFile?.code)).toEqual([
      "use Skir\\Runtime\\DenseJson;",
      "use Skir\\Runtime\\EnumValue;",
      "use Skir\\Runtime\\Type;",
      "use Skir\\Runtime\\Variant;",
      "use Neutral\\Models\\AccountObject;",
      "use Neutral\\Models\\AddressObject;",
    ]);
  });

  it("adapts enum wrapper storage and payload exposure through optional target hooks", () => {
    class EnumPayloadAdapter extends RecordingAdapter {
      public enumPayloadToSkirExpression(
        type: NormalizedType,
        expression: string,
        _context: RenderContext,
      ): string {
        this.calls.push(`enum-to:${type.kind}`);

        return type.kind === "string" ? expression : `enum_to_skir(${expression})`;
      }

      public enumPayloadFromSkirExpression(
        type: NormalizedType,
        expression: string,
        _context: RenderContext,
      ): string {
        this.calls.push(`enum-from:${type.kind}`);

        return type.kind === "string" ? expression : `enum_from_skir(${expression})`;
      }
    }

    const adapter = new EnumPayloadAdapter();
    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "events/status.skir",
        records: [{
          kind: "record",
          name: "Status",
          recordType: "enum",
          fields: [{
            kind: "field",
            name: "message",
            number: 1,
            type: "string",
          }, {
            kind: "field",
            name: "expires_at",
            number: 2,
            type: "timestamp",
          }],
        }],
      }],
      adapter,
    });
    const source = files.find((file) => file.path === "Events/StatusObject.php")?.code ?? "";

    expect(source).toContain("return new self(EnumValue::wrapper('message', $value));");
    expect(source).toContain("return new self(EnumValue::wrapper('expires_at', enum_to_skir($value)));");
    expect(source).toContain("return match ($this->value->name) {");
    expect(source).toContain("'expires_at' => enum_from_skir($this->value->value),");
    expect(source).toContain("default => $this->value->value,");
    expect(source).not.toContain("'message' =>");
    expect(adapter.calls).toContain("enum-to:timestamp");
    expect(adapter.calls).toContain("enum-from:timestamp");
  });

  it("keeps enum wrapper output byte-compatible when target hooks are absent", () => {
    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "events/status.skir",
        records: [{
          kind: "record",
          name: "Status",
          recordType: "enum",
          fields: [{
            kind: "field",
            name: "expires_at",
            number: 2,
            type: "timestamp",
          }],
        }],
      }],
      adapter: new RecordingAdapter(),
    });
    const source = files.find((file) => file.path === "Events/StatusObject.php")?.code ?? "";

    expect(source).toContain("return new self(EnumValue::wrapper('expires_at', $value));");
    expect(source).toContain([
      "public function payload(): mixed",
      "    {",
      "        return $this->value->value;",
      "    }",
    ].join("\n"));
    expect(source).not.toContain("return match ($this->value->name)");
  });

  it("preplans target enum imports that collide with generated record basenames", () => {
    const typedDataCollection = "StdOut\\SimpleDataObjects\\TypedDataCollection";

    class EnumImportCollisionAdapter extends RecordingAdapter {
      public override recordClassName(record: NormalizedRecord): string {
        return record.qualifiedName;
      }

      public enumImports(record: NormalizedRecord): readonly string[] {
        return record.recordType === "enum" ? [typedDataCollection] : [];
      }

      public enumPayloadFromSkirExpression(
        type: NormalizedType,
        expression: string,
        context: RenderContext,
      ): string {
        if (type.kind !== "array") {
          return expression;
        }

        return `${importClass(context.imports, typedDataCollection)}::of(${expression})`;
      }
    }

    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "models/events.skir",
        records: [{
          kind: "record",
          key: "collection-key",
          name: "TypedDataCollection",
          recordType: "struct",
          fields: [],
        }, {
          kind: "record",
          name: "CollectionEvent",
          recordType: "enum",
          fields: [{
            kind: "field",
            name: "collected",
            number: 1,
            type: {
              kind: "array",
              item: {
                kind: "record",
                key: "collection-key",
                recordType: "struct",
              },
            },
          }],
        }],
      }],
      adapter: new EnumImportCollisionAdapter(),
    });
    const source = files.find((file) => file.path === "Models/CollectionEvent.php")?.code ?? "";

    expect(source).toContain(
      "use StdOut\\SimpleDataObjects\\TypedDataCollection as SimpleDataObjectsTypedDataCollection;",
    );
    expect(source).toContain(
      "'collected' => SimpleDataObjectsTypedDataCollection::of($this->value->value),",
    );
  });

  it("renders each RPC file's runtime imports before sorted cross-module record imports", () => {
    class ImportingAdapter extends RecordingAdapter {
      public override toSkirExpression(
        type: NormalizedType,
        expression: string,
        context: RenderContext,
      ): string {
        this.calls.push(`to:${type.kind}`);

        return type.kind === "record"
          ? `${importedRecordClass(type, context)}::toSkir(${expression})`
          : expression;
      }

      public override fromSkirExpression(
        type: NormalizedType,
        expression: string,
        context: RenderContext,
      ): string {
        this.calls.push(`from:${type.kind}`);

        return type.kind === "record"
          ? `${importedRecordClass(type, context)}::fromSkir(${expression})`
          : expression;
      }
    }

    const zedReference = {
      kind: "record",
      key: "zed-key",
      recordType: "struct" as const,
    };
    const alphaReference = {
      kind: "record",
      key: "alpha-key",
      recordType: "struct" as const,
    };
    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "models/payloads.skir",
        records: [{
          kind: "record",
          key: "zed-key",
          name: "Zed",
          recordType: "struct",
          fields: [],
        }, {
          kind: "record",
          key: "alpha-key",
          name: "Alpha",
          recordType: "struct",
          fields: [],
        }],
      }, {
        path: "rpc/api.skir",
        methods: [{
          kind: "method",
          name: "Exchange",
          number: 1,
          requestType: zedReference,
          responseType: alphaReference,
        }, {
          kind: "method",
          name: "Lookup",
          number: 2,
          requestType: "string",
          responseType: alphaReference,
        }],
      }],
      adapter: new ImportingAdapter(),
    });

    expect(useStatements(files.find((file) => file.path === "Rpc/SkirMethods.php")?.code))
      .toEqual([
        "use Skir\\Runtime\\MethodDescriptor;",
        "use Skir\\Runtime\\Type;",
        "use Neutral\\Models\\AlphaObject;",
        "use Neutral\\Models\\ZedObject;",
      ]);
    expect(useStatements(files.find((file) => file.path === "Rpc/RpcSkirMethod.php")?.code))
      .toEqual([
        "use Skir\\Runtime\\MethodDescriptor;",
        "use Skir\\Server\\Contracts\\SkirMethodReference;",
      ]);
    expect(useStatements(files.find((file) => file.path === "Rpc/SkirRpcClient.php")?.code))
      .toEqual([
        "use Skir\\Client\\SkirClient;",
        "use Neutral\\Models\\AlphaObject;",
        "use Neutral\\Models\\ZedObject;",
      ]);
    expect(useStatements(files.find((file) => file.path === "Rpc/SkirProcedures.php")?.code))
      .toEqual([
        "use Skir\\Server\\SkirContext;",
        "use Neutral\\Models\\AlphaObject;",
        "use Neutral\\Models\\ZedObject;",
      ]);
    expect(useStatements(files.find((file) => file.path === "Rpc/AbstractSkirProcedures.php")?.code))
      .toEqual([
        "use Skir\\Server\\ProcedureProvider;",
        "use Skir\\Server\\SkirContext;",
        "use Skir\\Server\\SkirServer;",
        "use Neutral\\Models\\AlphaObject;",
        "use Neutral\\Models\\ZedObject;",
      ]);
    expect(useStatements(files.find((file) => file.path === "Rpc/SkirProcedureProvider.php")?.code))
      .toEqual([
        "use Skir\\Server\\ProcedureProvider;",
        "use Skir\\Server\\SkirContext;",
        "use Skir\\Server\\SkirServer;",
        "use Neutral\\Models\\AlphaObject;",
        "use Neutral\\Models\\ZedObject;",
      ]);
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

  it("does not import the runtime Type when all descriptors are direct records", () => {
    const recordReference = {
      kind: "record",
      key: "direct-record-key",
      recordType: "struct" as const,
    };
    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "rpc/direct.skir",
        records: [{
          kind: "record",
          key: "direct-record-key",
          name: "DirectRecord",
          recordType: "struct",
          fields: [],
        }],
        methods: [{
          kind: "method",
          name: "Echo",
          number: 1,
          requestType: recordReference,
          responseType: recordReference,
        }],
      }],
      adapter: new RecordingAdapter(),
    });
    const methodsFile = files.find((file) => file.path === "Rpc/SkirMethods.php");

    expect(methodsFile?.code).not.toContain("use Skir\\Runtime\\Type");
    expect(methodsFile?.code).not.toContain("Type::");
    expect(methodsFile?.code).toContain("DirectRecordObject::skirType()");
  });

  it("aliases the runtime Type when a planned generated class reserves its basename", () => {
    class TypeCollisionAdapter extends RecordingAdapter {
      public override recordClassName(record: NormalizedRecord): string {
        this.calls.push(`class:${record.identity}`);

        return record.qualifiedName === "Type"
          ? "Type"
          : super.recordClassName(record);
      }
    }

    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "models/type.skir",
        records: [{
          kind: "record",
          key: "type-key",
          name: "Type",
          recordType: "struct",
          fields: [],
        }],
      }, {
        path: "rpc/primitives.skir",
        methods: [{
          kind: "method",
          name: "Echo",
          number: 1,
          requestType: "string",
          responseType: {
            kind: "optional",
            other: { kind: "array", item: "int32" },
          },
        }],
      }],
      adapter: new TypeCollisionAdapter(),
    });
    const methodsFile = files.find((file) => file.path === "Rpc/SkirMethods.php");

    expect(useStatements(methodsFile?.code)).toEqual([
      "use Skir\\Runtime\\MethodDescriptor;",
      "use Skir\\Runtime\\Type as RuntimeType;",
    ]);
    expect(methodsFile?.code).toContain("requestType: RuntimeType::string(),");
    expect(methodsFile?.code).toContain(
      "responseType: RuntimeType::optional(RuntimeType::array(RuntimeType::int32())),",
    );
  });

  it("preplans target-specific struct imports once without consulting enums", () => {
    class StructImportAdapter extends RecordingAdapter {
      public readonly structImportCalls: string[] = [];

      public override recordClassName(record: NormalizedRecord): string {
        return record.qualifiedName;
      }

      public structImports(record: NormalizedRecord): readonly string[] {
        this.structImportCalls.push(record.identity);

        return ["Neutral\\Runtime\\Data"];
      }

      public override renderStruct({ record, context }: StructRenderRequest): GeneratedFile {
        const dataClass = importClass(context.imports, "Neutral\\Runtime\\Data");

        return {
          path: pathFor(context, `${classNameFor(record, context)}.php`),
          code: dataClass,
        };
      }
    }

    const adapter = new StructImportAdapter();
    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "models/types.skir",
        records: [{
          kind: "record",
          name: "Data",
          recordType: "struct",
          fields: [],
        }, {
          kind: "record",
          name: "State",
          recordType: "enum",
          fields: [],
        }],
      }],
      adapter,
    });

    expect(adapter.structImportCalls).toEqual(["models/types.skir::Data"]);
    expect(files.find((file) => file.path === "Models/Data.php")?.code).toBe("RuntimeData");
    expect(files.find((file) => file.path === "Models/State.php")?.code)
      .not.toContain("Skir\\Runtime\\Field");
  });

  it("aliases cross-module DTOs that collide with generated RPC sibling classes", () => {
    class RpcSiblingCollisionAdapter extends RecordingAdapter {
      public override recordClassName(record: NormalizedRecord): string {
        this.calls.push(`class:${record.identity}`);

        return record.qualifiedName;
      }

      public override toSkirExpression(
        type: NormalizedType,
        expression: string,
        context: RenderContext,
      ): string {
        this.calls.push(`to:${type.kind}`);

        return type.kind === "record"
          ? `${importedRecordClass(type, context)}::toSkir(${expression})`
          : expression;
      }

      public override fromSkirExpression(
        type: NormalizedType,
        expression: string,
        context: RenderContext,
      ): string {
        this.calls.push(`from:${type.kind}`);

        return type.kind === "record"
          ? `${importedRecordClass(type, context)}::fromSkir(${expression})`
          : expression;
      }

      public override clientResponseExpression(
        type: NormalizedType,
        expression: string,
        context: RenderContext,
      ): string {
        this.calls.push(`client:${type.kind}`);

        return type.kind === "record"
          ? `${importedRecordClass(type, context)}::fromClient(${expression})`
          : expression;
      }
    }

    const skirMethodsReference = {
      kind: "record",
      key: "skir-methods-key",
      recordType: "struct" as const,
    };
    const skirProceduresReference = {
      kind: "record",
      key: "skir-procedures-key",
      recordType: "struct" as const,
    };
    const files = generatePhp({
      namespace: "Neutral",
      modules: [{
        path: "models/dtos.skir",
        records: [{
          kind: "record",
          key: "skir-methods-key",
          name: "SkirMethods",
          recordType: "struct",
          fields: [],
        }, {
          kind: "record",
          key: "skir-procedures-key",
          name: "SkirProcedures",
          recordType: "struct",
          fields: [],
        }],
      }, {
        path: "rpc/api.skir",
        methods: [{
          kind: "method",
          name: "Collide",
          number: 1,
          requestType: skirMethodsReference,
          responseType: skirProceduresReference,
        }],
      }],
      adapter: new RpcSiblingCollisionAdapter(),
    });
    const methodsFile = files.find((file) => file.path === "Rpc/SkirMethods.php");
    const methodEnumFile = files.find((file) => file.path === "Rpc/RpcSkirMethod.php");
    const clientFile = files.find((file) => file.path === "Rpc/SkirRpcClient.php");
    const proceduresFile = files.find((file) => file.path === "Rpc/SkirProcedures.php");
    const abstractFile = files.find((file) => file.path === "Rpc/AbstractSkirProcedures.php");
    const providerFile = files.find((file) => file.path === "Rpc/SkirProcedureProvider.php");

    expect(methodsFile?.code).toContain(
      "use Neutral\\Models\\SkirMethods as ModelsSkirMethods;",
    );
    expect(methodsFile?.code).toContain("requestType: ModelsSkirMethods::skirType(),");
    expect(methodEnumFile?.code).not.toContain("use Neutral\\Models");
    expect(methodEnumFile?.code).toContain("SkirMethods::collide()");
    expect(clientFile?.code).toContain(
      "use Neutral\\Models\\SkirMethods as ModelsSkirMethods;",
    );
    expect(clientFile?.code).toContain("$this->client->invoke(SkirMethods::collide(),");
    expect(proceduresFile?.code).toContain(
      "use Neutral\\Models\\SkirProcedures as ModelsSkirProcedures;",
    );
    expect(proceduresFile?.code).toContain(
      "public function collide(SkirMethods $request, SkirContext $context): ModelsSkirProcedures;",
    );
    expect(abstractFile?.code).toContain(
      "use Neutral\\Models\\SkirMethods as ModelsSkirMethods;",
    );
    expect(abstractFile?.code).toContain("SkirMethods::collide()");
    expect(providerFile?.code).toContain(
      "use Neutral\\Models\\SkirMethods as ModelsSkirMethods;",
    );
    expect(providerFile?.code).toContain(
      "use Neutral\\Models\\SkirProcedures as ModelsSkirProcedures;",
    );
    expect(providerFile?.code).toContain("private SkirProcedures $procedures,");
    expect(providerFile?.code).toContain("SkirMethods::collide()");
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

function useStatements(code: string | undefined): readonly string[] {
  return code?.split("\n").filter((line) => line.startsWith("use ")) ?? [];
}
