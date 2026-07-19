# PHP Skir Generator Core

[![Tests](https://github.com/php-skir/generator-core/actions/workflows/tests.yml/badge.svg)](https://github.com/php-skir/generator-core/actions/workflows/tests.yml)
[![Coverage](https://raw.githubusercontent.com/php-skir/generator-core/badges/coverage.svg)](https://github.com/php-skir/generator-core/actions/workflows/tests.yml)
[![npm](https://img.shields.io/badge/npm-unreleased-lightgrey?logo=npm)](https://www.npmjs.com/package/@php-skir/generator-core)
[![Node.js](https://img.shields.io/badge/Node.js-22%20%7C%2024-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/php-skir/generator-core)](LICENSE)

`@php-skir/generator-core` is the shared build-time TypeScript core for PHP Skir code generators. It normalizes Skir producer values, resolves PHP names and imports, renders the common enum and RPC surface, produces the server manifest, and provides Composer configuration helpers.

Applications normally install a target generator such as `skir-php-generator` rather than this package directly. This package is not a replacement for `php-skir/runtime`: the core runs under Node while generating files, whereas generated PHP uses the Composer runtime in the application.

## Install

Adapter packages install the core as a normal runtime dependency of the generator:

```bash
npm install @php-skir/generator-core
```

The package is ESM and exports its public API from `@php-skir/generator-core`.

## Generation pipeline

The main entry point accepts producer-compatible modules and returns generated files without writing them to disk:

```ts
import {
  generatePhp,
  type CoreGeneratorInput,
  type PhpTargetAdapter,
} from "@php-skir/generator-core";

export function generate(
  input: CoreGeneratorInput,
  namespace: string,
  adapter: PhpTargetAdapter,
) {
  return generatePhp({
    namespace,
    modules: input.modules,
    ...(input.recordMap === undefined ? {} : { recordMap: input.recordMap }),
    adapter,
  });
}
```

`generatePhp()` performs these phases:

1. Normalize modules and external record locations into the PHP-oriented `NormalizedSchema`.
2. Resolve deterministic record class names with `recordClassName()`.
3. Call the optional `prepare()` hook once.
4. Preplan imports and render target structs, shared enum wrappers, and the complete RPC surface.
5. Produce `skir-server-manifest.json` and reject duplicate output paths.

`generateNormalizedPhp()` starts at phase four. Callers using it must supply both a normalized schema and a matching `PhpNameRegistry`; it deliberately does not call `prepare()`.

## Adapter contract

Targets implement `PhpTargetAdapter`. The normalized model is the boundary: the core owns Skir input normalization and common output, while the adapter owns DTO-library-specific structs, PHP types, hydration, and wire conversion.

### Identity and lifecycle

| Member | Purpose |
| --- | --- |
| `id` | Stable generator identifier written to the server manifest. |
| `recordClassName(record)` | Returns the unqualified PHP class name for a normalized record. It must be deterministic and valid for structs and enums. This runs before `prepare()`. |
| `prepare?(schema)` | Resolves schema-wide, target-specific state before files render. Replace prior state here because an adapter instance may be used more than once. |

### Import planning and struct rendering

| Member | Purpose |
| --- | --- |
| `structImports?(record)` | Returns fully qualified classes that a struct may import. |
| `enumImports?(record)` | Returns fully qualified classes that an enum may import. |
| `rpcImports?(methods)` | Returns fully qualified classes that an RPC module may import. |
| `renderStruct({ record, context })` | Returns the target-specific struct as one `{ path, code }` generated file. |

Import hooks are planning hooks, not rendered `use` statements. Include every conditional or collision-prone class they may need. During rendering, call `importClass(context.imports, fullyQualifiedClassName)` to obtain the stable local name, then call `renderUseStatements()` when assembling the file. The registry reserves generated sibling names and allocates aliases case-insensitively, independent of the order in which imports are requested.

`RenderContext` supplies the root namespace, current namespace, output path prefix, resolved record names, and the file's import registry. Helpers such as `renderPhpFile()`, `indent()`, and `PHP_FILE_HEADER` keep generated PHP consistent.

### PHP types and wire conversion

| Member | Purpose |
| --- | --- |
| `phpType(type, context)` | Renders the target-facing PHP type declaration. |
| `toSkirExpression(type, expression, context)` | Converts a target value to the representation accepted by the Skir client/runtime. |
| `fromSkirExpression(type, expression, context)` | Converts a decoded Skir value to the target representation used by procedures. |
| `clientResponseExpression(type, expression, context)` | Converts the raw client response to the target-facing return value. |
| `enumPayloadToSkirExpression?(...)` | Converts a wrapped enum payload before it is stored; omission keeps the value unchanged. |
| `enumPayloadFromSkirExpression?(...)` | Converts a wrapped enum payload when it is read; omission returns the stored value unchanged. |

The core passes the complete `NormalizedType` at each target-specific conversion boundary. The adapter remains responsible for recursively handling arrays, optionals, records, and any DTO collection types.

### Manifest hooks

| Member | Purpose |
| --- | --- |
| `manifestPhpType?(type, context)` | Overrides a non-record manifest type. Omission falls back to `phpType()`; the core handles record class names and nullable wrapping. |
| `manifestObjectClass(type, context)` | Returns the class the server should construct for an object value, or `null` when the value has no constructible object class. |

The core uses `manifestObjectClass()` for struct requests and record responses after unwrapping optionals. The manifest remains schema version `SERVER_MANIFEST_VERSION`.

## Optional validation overlays

Validation is an adapter capability, not automatic core behavior. Validation-aware targets can include `ValidationConfig` in their own configuration schema and call `resolveValidationRules(schema, config)` from `prepare()`. The resolver validates exact module, qualified-record, and original Skir field selectors and returns rules grouped by normalized record identity. The target decides how those string rules are rendered and executed.

Framework-independent targets can omit validation entirely without adding a runtime validation dependency.

## Compatibility expectations

The public exports, normalized model, and `PhpTargetAdapter` contract are compatibility-sensitive and follow semantic versioning. Changes to common renderers must be checked against each adapter's generated-output fixtures.

Optional behavior stays opt-in. An adapter that omits optional import, lifecycle, enum-payload, or manifest-type hooks receives the documented fallback, and adding a new capability must not change that adapter's generated bytes. Existing adapters likewise preserve byte-for-byte output when an optional configuration such as validation is absent.

When a deliberate shared-output correction is necessary, update it explicitly in the affected adapters and document the compatibility delta rather than silently refreshing snapshots.

## Local adapter development

Install and build the core first:

```bash
cd /path/to/generator-core
npm ci
npm run build
```

Then link that checkout into an adapter without replacing its declared semver dependency or updating its lockfile:

```bash
cd /path/to/adapter
npm link --no-save --package-lock=false /path/to/generator-core
```

The link uses the core's built `dist` directory. Re-run `npm run build` in the core after source changes, then run the adapter's tests. Before release verification, replace the link with the published dependency and use `npm ci` to prove the lockfile installs cleanly.

## Development

Node 22 is used in CI. From a clean checkout:

```bash
npm ci
npm run typecheck
npm run build
npm run pack:dry-run
npm test
```

- `npm run typecheck` checks the public TypeScript surface without emitting files.
- `npm run build` creates ESM JavaScript and declarations in `dist`.
- `npm run pack:dry-run` verifies the npm package contents without creating a tarball.
- `npm test` runs the Vitest unit and integration suite.

Contributions should keep the core independent of PHP DTO libraries, add focused tests for behavior changes, and verify downstream adapter compatibility when shared rendering or public types change.
