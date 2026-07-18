import type { PhpTargetAdapter, RenderContext } from "./adapter.js";
import {
  createImportRegistry,
  importClass,
  renderUseStatements,
} from "./imports.js";
import type {
  GeneratedFile,
  NormalizedMethod,
  NormalizedModule,
  NormalizedType,
} from "./model.js";
import type { PhpNameRegistry } from "./naming.js";
import { toClassName, toPropertyName } from "./naming.js";
import { indent, renderPhpFile } from "./php.js";

export interface RenderRpcInput {
  readonly rootNamespace: string;
  readonly module: NormalizedModule;
  readonly methods: readonly NormalizedMethod[];
  readonly names: PhpNameRegistry;
  readonly adapter: PhpTargetAdapter;
  readonly plannedImports?: readonly string[];
}

export function renderRpcFiles(input: RenderRpcInput): GeneratedFile[] {
  if (input.methods.length === 0) {
    return [];
  }

  return [
    renderMethodsFile(input),
    renderMethodEnumFile(input),
    renderClientFile(input),
    renderProceduresFile(input),
    renderAbstractProceduresFile(input),
    renderProcedureProviderFile(input),
  ];
}

export function methodEnumClassName(module: NormalizedModule): string {
  if (module.namespaceSegments.length === 0) {
    return "SkirMethod";
  }

  return `${module.namespaceSegments.join("")}SkirMethod`;
}

function renderMethodsFile(input: RenderRpcInput): GeneratedFile {
  const context = createFileContext(input, "SkirMethods", [
    "Skir\\Runtime\\MethodDescriptor",
  ]);
  const methodDescriptor = importClass(context.imports, "Skir\\Runtime\\MethodDescriptor");
  const descriptors = input.methods
    .map((method) => renderMethodDescriptor(method, context, input.adapter, methodDescriptor))
    .join("\n\n");
  const body = [
    "final readonly class SkirMethods",
    "{",
    indent(renderAllMethods(input.methods, methodDescriptor)),
    "",
    indent(descriptors),
    "}",
  ].join("\n");

  return renderGeneratedPhpFile(context, "SkirMethods.php", body);
}

function renderMethodEnumFile(input: RenderRpcInput): GeneratedFile {
  const className = methodEnumClassName(input.module);
  const context = createFileContext(input, className, [
    "Skir\\Runtime\\MethodDescriptor",
    "Skir\\Server\\Contracts\\SkirMethodReference",
  ]);
  const methodDescriptor = importClass(context.imports, "Skir\\Runtime\\MethodDescriptor");
  const skirMethodReference = importClass(
    context.imports,
    "Skir\\Server\\Contracts\\SkirMethodReference",
  );
  const cases = input.methods
    .map((method) => `case ${toClassName(method.name)};`)
    .join("\n");
  const matches = input.methods
    .map((method) => `self::${toClassName(method.name)} => SkirMethods::${toPropertyName(method.name)}(),`)
    .join("\n");
  const body = [
    `enum ${className} implements ${skirMethodReference}`,
    "{",
    indent(cases),
    "",
    indent([
      `public function descriptor(): ${methodDescriptor}`,
      "{",
      "    return match ($this) {",
      indent(indent(matches)),
      "    };",
      "}",
    ].join("\n")),
    "}",
  ].join("\n");

  return renderGeneratedPhpFile(context, `${className}.php`, body);
}

function renderAllMethods(
  methods: readonly NormalizedMethod[],
  methodDescriptor: string,
): string {
  return [
    `/** @return array<string, ${methodDescriptor}> */`,
    "public static function all(): array",
    "{",
    "    return [",
    ...methods.map((method) => `        '${method.name}' => self::${toPropertyName(method.name)}(),`),
    "    ];",
    "}",
  ].join("\n");
}

function renderMethodDescriptor(
  method: NormalizedMethod,
  context: RenderContext,
  adapter: PhpTargetAdapter,
  methodDescriptor: string,
): string {
  return [
    `public static function ${toPropertyName(method.name)}(): ${methodDescriptor}`,
    "{",
    `    return new ${methodDescriptor}(`,
    `        name: '${method.name}',`,
    `        number: ${method.number},`,
    `        requestType: ${runtimeTypeExpression(method.requestType, context, adapter)},`,
    `        responseType: ${runtimeTypeExpression(method.responseType, context, adapter)},`,
    "    );",
    "}",
  ].join("\n");
}

function renderClientFile(input: RenderRpcInput): GeneratedFile {
  const context = createFileContext(input, "SkirRpcClient", [
    "Skir\\Client\\SkirClient",
  ]);
  const skirClient = importClass(context.imports, "Skir\\Client\\SkirClient");
  const clientMethods = input.methods
    .map((method) => renderClientMethod(method, context, input.adapter))
    .join("\n\n");
  const body = [
    "final readonly class SkirRpcClient",
    "{",
    indent([
      "public function __construct(",
      `    private ${skirClient} $client,`,
      ") {}",
    ].join("\n")),
    "",
    indent(clientMethods),
    "}",
  ].join("\n");

  return renderGeneratedPhpFile(context, "SkirRpcClient.php", body);
}

function renderClientMethod(
  method: NormalizedMethod,
  context: RenderContext,
  adapter: PhpTargetAdapter,
): string {
  const methodName = toPropertyName(method.name);
  const request = adapter.toSkirExpression(method.requestType, "$request", context);
  const response = adapter.clientResponseExpression(method.responseType, "$response", context);

  return [
    `public function ${methodName}(${adapter.phpType(method.requestType, context)} $request): ${adapter.phpType(method.responseType, context)}`,
    "{",
    `    $response = $this->client->invoke(SkirMethods::${methodName}(), ${request});`,
    "",
    `    return ${response};`,
    "}",
  ].join("\n");
}

function renderProceduresFile(input: RenderRpcInput): GeneratedFile {
  const context = createFileContext(input, "SkirProcedures", [
    "Skir\\Server\\SkirContext",
  ]);
  const skirContext = importClass(context.imports, "Skir\\Server\\SkirContext");
  const procedureMethods = input.methods
    .map((method) => renderProcedureMethod(method, context, input.adapter, skirContext))
    .join("\n\n");
  const body = [
    "interface SkirProcedures",
    "{",
    indent(procedureMethods),
    "}",
  ].join("\n");

  return renderGeneratedPhpFile(context, "SkirProcedures.php", body);
}

function renderProcedureMethod(
  method: NormalizedMethod,
  context: RenderContext,
  adapter: PhpTargetAdapter,
  skirContext: string,
): string {
  return `public function ${toPropertyName(method.name)}(${adapter.phpType(method.requestType, context)} $request, ${skirContext} $context): ${adapter.phpType(method.responseType, context)};`;
}

function renderAbstractProceduresFile(input: RenderRpcInput): GeneratedFile {
  const context = createFileContext(input, "AbstractSkirProcedures", [
    "Skir\\Server\\ProcedureProvider",
    "Skir\\Server\\SkirContext",
    "Skir\\Server\\SkirServer",
  ]);
  const procedureProvider = importClass(context.imports, "Skir\\Server\\ProcedureProvider");
  const skirContext = importClass(context.imports, "Skir\\Server\\SkirContext");
  const skirServer = importClass(context.imports, "Skir\\Server\\SkirServer");
  const procedureMethods = input.methods
    .map((method) => renderAbstractProcedureMethod(
      method,
      context,
      input.adapter,
      skirContext,
    ))
    .join("\n\n");
  const registrations = input.methods
    .map((method) => renderProcedureRegistration(
      method,
      context,
      input.adapter,
      skirContext,
      "$this",
    ))
    .join("\n\n");
  const body = [
    `abstract class AbstractSkirProcedures implements ${procedureProvider}`,
    "{",
    indent(procedureMethods),
    "",
    indent([
      `public function register(${skirServer} $server): void`,
      "{",
      indent(registrations),
      "}",
    ].join("\n")),
    "}",
  ].join("\n");

  return renderGeneratedPhpFile(context, "AbstractSkirProcedures.php", body);
}

function renderAbstractProcedureMethod(
  method: NormalizedMethod,
  context: RenderContext,
  adapter: PhpTargetAdapter,
  skirContext: string,
): string {
  return `abstract public function ${toPropertyName(method.name)}(${adapter.phpType(method.requestType, context)} $request, ${skirContext} $context): ${adapter.phpType(method.responseType, context)};`;
}

function renderProcedureProviderFile(input: RenderRpcInput): GeneratedFile {
  const context = createFileContext(input, "SkirProcedureProvider", [
    "Skir\\Server\\ProcedureProvider",
    "Skir\\Server\\SkirContext",
    "Skir\\Server\\SkirServer",
  ]);
  const procedureProvider = importClass(context.imports, "Skir\\Server\\ProcedureProvider");
  const skirContext = importClass(context.imports, "Skir\\Server\\SkirContext");
  const skirServer = importClass(context.imports, "Skir\\Server\\SkirServer");
  const registrations = input.methods
    .map((method) => renderProcedureRegistration(
      method,
      context,
      input.adapter,
      skirContext,
    ))
    .join("\n\n");
  const body = [
    `final readonly class SkirProcedureProvider implements ${procedureProvider}`,
    "{",
    indent([
      "public function __construct(",
      "    private SkirProcedures $procedures,",
      ") {}",
    ].join("\n")),
    "",
    indent([
      `public function register(${skirServer} $server): void`,
      "{",
      indent(registrations),
      "}",
    ].join("\n")),
    "}",
  ].join("\n");

  return renderGeneratedPhpFile(context, "SkirProcedureProvider.php", body);
}

function renderProcedureRegistration(
  method: NormalizedMethod,
  context: RenderContext,
  adapter: PhpTargetAdapter,
  skirContext: string,
  handlerTarget = "$this->procedures",
): string {
  const methodName = toPropertyName(method.name);
  const request = adapter.fromSkirExpression(method.requestType, "$request", context);
  const response = adapter.toSkirExpression(method.responseType, "$response", context);

  return [
    `$server->addMethod(SkirMethods::${methodName}(), function (mixed $request, ${skirContext} $context): mixed {`,
    `    $response = ${handlerTarget}->${methodName}(${request}, $context);`,
    "",
    `    return ${response};`,
    "});",
  ].join("\n");
}

function runtimeTypeExpression(
  type: NormalizedType,
  context: RenderContext,
  adapter: PhpTargetAdapter,
): string {
  if (type.kind === "array") {
    return `Type::array(${runtimeTypeExpression(type.item, context, adapter)})`;
  }

  if (type.kind === "optional") {
    return `Type::optional(${runtimeTypeExpression(type.inner, context, adapter)})`;
  }

  if (type.kind === "record") {
    return `${adapter.phpType(type, context)}::skirType()`;
  }

  return `Type::${type.kind}()`;
}

function createFileContext(
  input: RenderRpcInput,
  className: string,
  runtimeImports: readonly string[],
): RenderContext {
  const namespace = [input.rootNamespace, ...input.module.namespaceSegments]
    .filter((segment) => segment !== "")
    .join("\\");

  return {
    rootNamespace: input.rootNamespace,
    namespace,
    pathPrefix: input.module.namespaceSegments.join("/"),
    names: input.names,
    imports: createImportRegistry(
      [className],
      [...(input.plannedImports ?? []), ...runtimeImports],
    ),
  };
}

function renderGeneratedPhpFile(
  context: RenderContext,
  fileName: string,
  body: string,
): GeneratedFile {
  return {
    path: context.pathPrefix === "" ? fileName : `${context.pathPrefix}/${fileName}`,
    code: renderPhpFile({
      namespace: context.namespace,
      imports: renderUseStatements(context.imports),
      body,
    }),
  };
}
