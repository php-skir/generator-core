export interface ImportRegistry {
  readonly reservedNames: ReadonlySet<string>;
  readonly imports: Map<string, string>;
}

const PHP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createImportRegistry(reservedNames: Iterable<string>): ImportRegistry {
  const normalizedReservedNames = new Set<string>();

  for (const reservedName of reservedNames) {
    if (!PHP_IDENTIFIER.test(reservedName)) {
      throw new Error(
        `Invalid reserved PHP name "${reservedName}"; expected an ASCII identifier starting with a letter or underscore and containing only letters, numbers, and underscores.`,
      );
    }

    normalizedReservedNames.add(reservedName);
  }

  return {
    reservedNames: normalizedReservedNames,
    imports: new Map(),
  };
}

export function importClass(
  registry: ImportRegistry,
  fullyQualifiedClassName: string,
): string {
  const canonicalClassName = canonicalFullyQualifiedClassName(fullyQualifiedClassName);
  const existingImport = findImportByClassName(registry, canonicalClassName);

  if (existingImport !== undefined) {
    return existingImport;
  }

  const caseInsensitiveImport = findCaseInsensitiveImportByClassName(
    registry,
    canonicalClassName,
  );

  if (caseInsensitiveImport !== undefined) {
    throw new Error(
      `The same case-insensitive PHP class is already imported as ${caseInsensitiveImport.fullyQualifiedClassName}; cannot also import ${canonicalClassName}. Use one canonical class-name spelling.`,
    );
  }

  const parts = canonicalClassName.split("\\");
  const shortName = parts.at(-1);

  if (shortName === undefined) {
    throw new Error(`Cannot resolve the short PHP class name for ${canonicalClassName}.`);
  }

  const alias = resolveAlias(registry, parts, shortName);

  registry.imports.set(alias, canonicalClassName);

  return alias;
}

export function renderUseStatements(registry: ImportRegistry): readonly string[] {
  return [...registry.imports.entries()]
    .map(([alias, fullyQualifiedClassName]) => {
      const shortName = fullyQualifiedClassName.split("\\").at(-1);

      return alias === shortName
        ? `use ${fullyQualifiedClassName};`
        : `use ${fullyQualifiedClassName} as ${alias};`;
    })
    .sort();
}

function canonicalFullyQualifiedClassName(fullyQualifiedClassName: string): string {
  const canonicalClassName = fullyQualifiedClassName.startsWith("\\")
    ? fullyQualifiedClassName.slice(1)
    : fullyQualifiedClassName;

  if (canonicalClassName === "") {
    throw new Error("Cannot import an empty PHP fully qualified class name.");
  }

  const parts = canonicalClassName.split("\\");

  if (parts.some((part) => part === "")) {
    throw new Error(
      `Invalid PHP fully qualified class name "${fullyQualifiedClassName}": empty namespace segments are not allowed.`,
    );
  }

  const invalidPart = parts.find((part) => !PHP_IDENTIFIER.test(part));

  if (invalidPart !== undefined) {
    throw new Error(
      `Invalid PHP fully qualified class name "${fullyQualifiedClassName}": segment "${invalidPart}" is not a valid PHP identifier.`,
    );
  }

  return canonicalClassName;
}

function findImportByClassName(
  registry: ImportRegistry,
  fullyQualifiedClassName: string,
): string | undefined {
  for (const [alias, importedClassName] of registry.imports) {
    if (importedClassName === fullyQualifiedClassName) {
      return alias;
    }
  }

  return undefined;
}

function findCaseInsensitiveImportByClassName(
  registry: ImportRegistry,
  fullyQualifiedClassName: string,
): { readonly alias: string; readonly fullyQualifiedClassName: string } | undefined {
  const comparisonName = fullyQualifiedClassName.toLowerCase();

  for (const [alias, importedClassName] of registry.imports) {
    if (importedClassName.toLowerCase() === comparisonName) {
      return { alias, fullyQualifiedClassName: importedClassName };
    }
  }

  return undefined;
}

function resolveAlias(
  registry: ImportRegistry,
  classNameParts: readonly string[],
  shortName: string,
): string {
  const namespaceParts = classNameParts.slice(0, -1);
  const prefixedShortName = `${shortName.charAt(0).toUpperCase()}${shortName.slice(1)}`;
  const candidates = [shortName];

  for (let index = namespaceParts.length - 1; index >= 0; index -= 1) {
    candidates.push(`${namespaceParts.slice(index).join("")}${prefixedShortName}`);
  }

  for (const candidate of candidates) {
    if (!isLocalNameUsed(registry, candidate)) {
      return candidate;
    }
  }

  const baseAlias = candidates.at(-1) ?? shortName;
  let suffix = 2;

  while (isLocalNameUsed(registry, `${baseAlias}${suffix}`)) {
    suffix += 1;
  }

  return `${baseAlias}${suffix}`;
}

function isLocalNameUsed(registry: ImportRegistry, localName: string): boolean {
  const comparisonName = localName.toLowerCase();

  return [...registry.reservedNames].some((name) => name.toLowerCase() === comparisonName)
    || [...registry.imports.keys()].some((name) => name.toLowerCase() === comparisonName);
}
