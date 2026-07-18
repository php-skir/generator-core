import { describe, expect, it } from "vitest";

import {
  buildPhpNameRegistry,
  createImportRegistry,
  normalizeSchema,
  type GeneratedFile,
  type NormalizedRecord,
  type NormalizedSchema,
  type NormalizedType,
  type PhpTargetAdapter,
  type RenderContext,
  type StructRenderRequest,
} from "../src/index.js";

class FakeTargetAdapter implements PhpTargetAdapter {
  public readonly id = "fake";

  public preparedSchema: NormalizedSchema | undefined;

  public prepare(schema: NormalizedSchema): void {
    this.preparedSchema = schema;
  }

  public recordClassName(record: NormalizedRecord): string {
    return `${record.qualifiedName}Object`;
  }

  public renderStruct({ record, context }: StructRenderRequest): GeneratedFile {
    return {
      path: `${context.pathPrefix}/${this.recordClassName(record)}.php`,
      code: `namespace ${context.namespace};`,
    };
  }

  public phpType(type: NormalizedType, context: RenderContext): string {
    return `${context.rootNamespace}:${type.kind}`;
  }

  public toSkirExpression(
    type: NormalizedType,
    expression: string,
    context: RenderContext,
  ): string {
    return `to:${context.namespace}:${type.kind}:${expression}`;
  }

  public fromSkirExpression(
    type: NormalizedType,
    expression: string,
    context: RenderContext,
  ): string {
    return `from:${context.namespace}:${type.kind}:${expression}`;
  }

  public clientResponseExpression(
    type: NormalizedType,
    expression: string,
    context: RenderContext,
  ): string {
    return `response:${context.pathPrefix}:${type.kind}:${expression}`;
  }

  public manifestObjectClass(type: NormalizedType, context: RenderContext): string | null {
    return type.kind === "record" ? `${context.namespace}\\ManifestObject` : null;
  }
}

describe("PhpTargetAdapter", () => {
  it("exposes every target operation through normalized core models", () => {
    const schema = normalizeSchema({
      modules: [{
        path: "admin/users.skir",
        records: [{
          kind: "record",
          key: "user-key",
          name: "User",
          recordType: "struct",
          fields: [],
        }],
      }],
    });
    const adapter = new FakeTargetAdapter();
    const names = buildPhpNameRegistry("Skir", schema, (record) => (
      adapter.recordClassName(record)
    ));
    const context: RenderContext = {
      rootNamespace: "Skir",
      namespace: "Skir\\Admin",
      pathPrefix: "Admin",
      names,
      imports: createImportRegistry(["UserObject", "Type"]),
    };
    const record = schema.modules[0]?.records[0];
    const type: NormalizedType = {
      kind: "record",
      recordIdentity: "admin/users.skir::User",
      recordType: "struct",
    };

    expect(record).toBeDefined();

    if (record === undefined) {
      throw new Error("Expected the normalized user record fixture.");
    }

    adapter.prepare?.(schema);

    expect(adapter.preparedSchema).toBe(schema);
    expect(adapter.recordClassName(record)).toBe("UserObject");
    expect(adapter.renderStruct({ record, context })).toEqual({
      path: "Admin/UserObject.php",
      code: "namespace Skir\\Admin;",
    });
    expect(adapter.phpType(type, context)).toBe("Skir:record");
    expect(adapter.toSkirExpression(type, "$value", context))
      .toBe("to:Skir\\Admin:record:$value");
    expect(adapter.fromSkirExpression(type, "$payload", context))
      .toBe("from:Skir\\Admin:record:$payload");
    expect(adapter.clientResponseExpression(type, "$response", context))
      .toBe("response:Admin:record:$response");
    expect(adapter.manifestObjectClass(type, context)).toBe("Skir\\Admin\\ManifestObject");
    expect(adapter.manifestObjectClass({ kind: "string" }, context)).toBeNull();
  });
});
