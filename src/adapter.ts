import type { ImportRegistry } from "./imports.js";
import type {
  GeneratedFile,
  NormalizedRecord,
  NormalizedSchema,
  NormalizedType,
} from "./model.js";
import type { PhpNameRegistry } from "./naming.js";

export interface PhpTargetAdapter {
  readonly id: string;
  prepare?(schema: NormalizedSchema): void;
  recordClassName(record: NormalizedRecord): string;
  structImports?(record: NormalizedRecord): readonly string[];
  enumImports?(record: NormalizedRecord): readonly string[];
  renderStruct(request: StructRenderRequest): GeneratedFile;
  phpType(type: NormalizedType, context: RenderContext): string;
  toSkirExpression(type: NormalizedType, expression: string, context: RenderContext): string;
  fromSkirExpression(type: NormalizedType, expression: string, context: RenderContext): string;
  enumPayloadToSkirExpression?(
    type: NormalizedType,
    expression: string,
    context: RenderContext,
  ): string;
  enumPayloadFromSkirExpression?(
    type: NormalizedType,
    expression: string,
    context: RenderContext,
  ): string;
  clientResponseExpression(
    type: NormalizedType,
    expression: string,
    context: RenderContext,
  ): string;
  manifestObjectClass(type: NormalizedType, context: RenderContext): string | null;
}

export interface StructRenderRequest {
  readonly record: NormalizedRecord;
  readonly context: RenderContext;
}

export interface RenderContext {
  readonly rootNamespace: string;
  readonly namespace: string;
  readonly pathPrefix: string;
  readonly names: PhpNameRegistry;
  readonly imports: ImportRegistry;
}
