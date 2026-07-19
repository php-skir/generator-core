import type { PhpTargetAdapter, RenderContext } from "./adapter.js";
import { importClass, renderUseStatements } from "./imports.js";
import type {
  GeneratedFile,
  NormalizedEnumConstant,
  NormalizedField,
  NormalizedRecord,
  NormalizedType,
} from "./model.js";
import { toPropertyName } from "./naming.js";
import { indent, renderPhpFile } from "./php.js";

export function renderEnum(
  record: NormalizedRecord,
  context: RenderContext,
  adapter: PhpTargetAdapter,
): GeneratedFile {
  if (record.recordType !== "enum") {
    throw new Error(`Cannot render non-enum record ${record.identity} as an enum.`);
  }

  const className = classNameForRecord(record, context);
  const runtimeImports = [
    "Skir\\Runtime\\DenseJson",
    "Skir\\Runtime\\EnumValue",
    "Skir\\Runtime\\Type",
    "Skir\\Runtime\\Variant",
  ] as const;
  const denseJson = importClass(context.imports, runtimeImports[0]);
  const enumValue = importClass(context.imports, runtimeImports[1]);
  const typeClass = importClass(context.imports, runtimeImports[2]);
  const variant = importClass(context.imports, runtimeImports[3]);
  const constructors = renderEnumConstructors(record, context, adapter, enumValue);
  const skirType = renderEnumSkirType(record, context, adapter, typeClass, variant);
  const body = [
    `final readonly class ${className}`,
    "{",
    indent(`private function __construct(private ${enumValue} $value) {}`),
    "",
    indent(constructors),
    "",
    indent(skirType),
    "",
    indent(renderEnumAccessors(record, context, adapter)),
    "",
    indent(renderEnumToSkirValue(enumValue)),
    "",
    indent(renderEnumFromSkirValue(className, enumValue)),
    "",
    indent(renderEnumToDenseValue(denseJson)),
    "",
    indent(renderEnumFromDenseValue(className, denseJson)),
    "",
    indent(renderEnumToDenseJson(denseJson)),
    "",
    indent(renderEnumFromDenseJson(className, denseJson)),
    "}",
  ].join("\n");

  return {
    path: outputPath(context, `${className}.php`),
    code: renderPhpFile({
      namespace: context.namespace,
      imports: renderUseStatements(context.imports, runtimeImports),
      body,
    }),
  };
}

function renderEnumConstructors(
  record: NormalizedRecord,
  context: RenderContext,
  adapter: PhpTargetAdapter,
  enumValue: string,
): string {
  return record.fields
    .filter((field): field is NormalizedField | NormalizedEnumConstant => field.kind === "field")
    .map((field) => {
      if (!field.hasPayload) {
        return [
          `public static function ${toPropertyName(field.name)}(): self`,
          "{",
          `    return new self(${enumValue}::constant('${field.name}'));`,
          "}",
        ].join("\n");
      }

      const storedValue = adapter.enumPayloadToSkirExpression?.(
        field.type,
        "$value",
        context,
      ) ?? "$value";

      return [
        `public static function ${toPropertyName(field.name)}(${adapter.phpType(field.type, context)} $value): self`,
        "{",
        `    return new self(${enumValue}::wrapper('${field.name}', ${storedValue}));`,
        "}",
      ].join("\n");
    })
    .join("\n\n");
}

function renderEnumSkirType(
  record: NormalizedRecord,
  context: RenderContext,
  adapter: PhpTargetAdapter,
  typeClass: string,
  variant: string,
): string {
  const entries = record.fields
    .filter((field): field is NormalizedField | NormalizedEnumConstant => field.kind === "field")
    .map((field) => {
      if (!field.hasPayload) {
        return `    ${variant}::constant('${field.name}', ${field.number}),`;
      }

      return `    ${variant}::wrapper('${field.name}', ${field.number}, ${runtimeTypeExpression(field.type, context, adapter, typeClass)}),`;
    })
    .join("\n");

  return [
    `public static function skirType(): ${typeClass}`,
    "{",
    `    return ${typeClass}::enum([`,
    entries,
    "    ]);",
    "}",
  ].join("\n");
}

function renderEnumAccessors(
  record: NormalizedRecord,
  context: RenderContext,
  adapter: PhpTargetAdapter,
): string {
  const rawPayload = "$this->value->value";
  const convertedPayloads = record.fields
    .filter((field): field is NormalizedField => (
      field.kind === "field" && field.hasPayload
    ))
    .map((field) => ({
      name: field.name,
      expression: adapter.enumPayloadFromSkirExpression?.(
        field.type,
        rawPayload,
        context,
      ) ?? rawPayload,
    }))
    .filter(({ expression }) => expression !== rawPayload);
  const payloadBody = convertedPayloads.length === 0
    ? [`    return ${rawPayload};`]
    : [
      "    return match ($this->value->name) {",
      ...convertedPayloads.map(({ name, expression }) => (
        `        '${name}' => ${expression},`
      )),
      `        default => ${rawPayload},`,
      "    };",
    ];

  return [
    "public function name(): string",
    "{",
    "    return $this->value->name;",
    "}",
    "",
    "public function payload(): mixed",
    "{",
    ...payloadBody,
    "}",
  ].join("\n");
}

function renderEnumToSkirValue(enumValue: string): string {
  return [
    `public function toSkirValue(): ${enumValue}`,
    "{",
    "    return $this->value;",
    "}",
  ].join("\n");
}

function renderEnumFromSkirValue(className: string, enumValue: string): string {
  return [
    `public static function fromSkirValue(${enumValue} $value): ${className}`,
    "{",
    "    return new self($value);",
    "}",
  ].join("\n");
}

function renderEnumToDenseValue(denseJson: string): string {
  return [
    "/** @return int|array<int, mixed> */",
    "public function toDenseValue(): int|array",
    "{",
    `    return ${denseJson}::encode(self::skirType(), $this->value);`,
    "}",
  ].join("\n");
}

function renderEnumFromDenseValue(className: string, denseJson: string): string {
  return [
    "/** @param int|array<int, mixed> $value */",
    `public static function fromDenseValue(int|array $value): ${className}`,
    "{",
    `    return new self(${denseJson}::decode(self::skirType(), $value));`,
    "}",
  ].join("\n");
}

function renderEnumToDenseJson(denseJson: string): string {
  return [
    "public function toDenseJson(): string",
    "{",
    `    return ${denseJson}::toJson(self::skirType(), $this->value);`,
    "}",
  ].join("\n");
}

function renderEnumFromDenseJson(className: string, denseJson: string): string {
  return [
    `public static function fromDenseJson(string $json): ${className}`,
    "{",
    `    return new self(${denseJson}::fromJson(self::skirType(), $json));`,
    "}",
  ].join("\n");
}

function runtimeTypeExpression(
  type: NormalizedType,
  context: RenderContext,
  adapter: PhpTargetAdapter,
  typeClass: string,
): string {
  if (type.kind === "array") {
    return `${typeClass}::array(${runtimeTypeExpression(type.item, context, adapter, typeClass)})`;
  }

  if (type.kind === "optional") {
    return `${typeClass}::optional(${runtimeTypeExpression(type.inner, context, adapter, typeClass)})`;
  }

  if (type.kind === "record") {
    return `${adapter.phpType(type, context)}::skirType()`;
  }

  return `${typeClass}::${type.kind}()`;
}

function classNameForRecord(record: NormalizedRecord, context: RenderContext): string {
  const className = context.names.namesByIdentity.get(record.identity);

  if (className === undefined) {
    throw new Error(`No PHP class name was resolved for enum ${record.identity}.`);
  }

  return className;
}

function outputPath(context: RenderContext, fileName: string): string {
  return context.pathPrefix === "" ? fileName : `${context.pathPrefix}/${fileName}`;
}
