export { normalizeSchema } from "./normalize.js";
export {
  buildPhpNameRegistry,
  toClassName,
  toPhpNamespaceSegment,
  toPropertyName,
} from "./naming.js";
export {
  createImportRegistry,
  importClass,
  renderUseStatements,
} from "./imports.js";
export {
  indent,
  PHP_FILE_HEADER,
  renderPhpFile,
} from "./php.js";
export type {
  PhpTargetAdapter,
  RenderContext,
  StructRenderRequest,
} from "./adapter.js";
export type { ImportRegistry } from "./imports.js";
export type { PhpNameRegistry } from "./naming.js";
export type { PhpFileInput } from "./php.js";
export type {
  CoreGeneratorInput,
  GeneratedFile,
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
