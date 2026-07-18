export interface ImportRegistry {
  readonly reservedNames: ReadonlySet<string>;
  readonly imports: ReadonlyMap<string, string>;
}

interface ImportRegistryState {
  readonly reservedNameKeys: ReadonlySet<string>;
  readonly imports: Map<string, string>;
  readonly aliasesByPlannedClass: ReadonlyMap<string, string>;
  readonly canonicalClassesByKey: Map<string, string>;
  readonly classNamesByShortName: Map<string, Set<string>>;
  readonly allocatedAliasKeys: Set<string>;
}

const PHP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PHP_RESERVED_CLASS_NAMES = new Set([
  "__halt_compiler",
  "abstract",
  "and",
  "array",
  "as",
  "bool",
  "break",
  "callable",
  "case",
  "catch",
  "class",
  "clone",
  "const",
  "continue",
  "declare",
  "default",
  "die",
  "do",
  "echo",
  "else",
  "elseif",
  "empty",
  "enddeclare",
  "endfor",
  "endforeach",
  "endif",
  "endswitch",
  "endwhile",
  "enum",
  "eval",
  "exit",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "fn",
  "for",
  "foreach",
  "function",
  "global",
  "goto",
  "if",
  "implements",
  "include",
  "include_once",
  "instanceof",
  "insteadof",
  "int",
  "interface",
  "isset",
  "iterable",
  "list",
  "match",
  "mixed",
  "namespace",
  "never",
  "new",
  "null",
  "object",
  "or",
  "parent",
  "print",
  "private",
  "protected",
  "public",
  "readonly",
  "require",
  "require_once",
  "resource",
  "return",
  "self",
  "static",
  "string",
  "switch",
  "throw",
  "trait",
  "true",
  "try",
  "unset",
  "use",
  "var",
  "void",
  "while",
  "xor",
  "yield",
  "yield_from",
]);
const REGISTRY_STATES = new WeakMap<ImportRegistry, ImportRegistryState>();

export function createImportRegistry(
  reservedNames: Iterable<string>,
  plannedImports: Iterable<string> = [],
): ImportRegistry {
  const normalizedReservedNames = normalizeReservedNames(reservedNames);
  const canonicalPlannedImports = normalizePlannedImports(plannedImports);
  const reservedNameKeys = new Set(
    [...normalizedReservedNames].map((name) => name.toLowerCase()),
  );
  const aliasesByPlannedClass = planAliases(canonicalPlannedImports, reservedNameKeys);
  const imports = new Map<string, string>();
  const canonicalClassesByKey = new Map<string, string>();
  const classNamesByShortName = new Map<string, Set<string>>();
  const allocatedAliasKeys = new Set(reservedNameKeys);

  for (const [fullyQualifiedClassName, alias] of aliasesByPlannedClass) {
    canonicalClassesByKey.set(fullyQualifiedClassName.toLowerCase(), fullyQualifiedClassName);
    addClassShortName(classNamesByShortName, fullyQualifiedClassName);
    allocatedAliasKeys.add(alias.toLowerCase());
  }

  const registry = Object.freeze({
    reservedNames: new ReadonlySetView(normalizedReservedNames),
    imports: new ReadonlyMapView(imports),
  });

  REGISTRY_STATES.set(registry, {
    reservedNameKeys,
    imports,
    aliasesByPlannedClass,
    canonicalClassesByKey,
    classNamesByShortName,
    allocatedAliasKeys,
  });

  return registry;
}

export function importClass(
  registry: ImportRegistry,
  fullyQualifiedClassName: string,
): string {
  const state = registryState(registry);
  const canonicalClassName = canonicalFullyQualifiedClassName(fullyQualifiedClassName);
  const existingAlias = findImportByClassName(state.imports, canonicalClassName);

  if (existingAlias !== undefined) {
    return existingAlias;
  }

  const plannedAlias = state.aliasesByPlannedClass.get(canonicalClassName);

  if (plannedAlias !== undefined) {
    state.imports.set(plannedAlias, canonicalClassName);

    return plannedAlias;
  }

  const classNameKey = canonicalClassName.toLowerCase();
  const caseInsensitiveClass = state.canonicalClassesByKey.get(classNameKey);

  if (caseInsensitiveClass !== undefined) {
    throwCaseInsensitiveClassError(caseInsensitiveClass, canonicalClassName);
  }

  const parts = canonicalClassName.split("\\");
  const shortName = parts.at(-1);

  if (shortName === undefined) {
    throw new Error(`Cannot resolve the short PHP class name for ${canonicalClassName}.`);
  }

  const shortNameKey = shortName.toLowerCase();
  const classesWithShortName = state.classNamesByShortName.get(shortNameKey);

  if (classesWithShortName !== undefined && classesWithShortName.size > 0) {
    throw new Error(
      `Cannot safely import ${canonicalClassName}: its basename ${shortName} collides with an import whose alias may already have been returned. Preplan all colliding imports with the second createImportRegistry argument.`,
    );
  }

  const alias = resolveAvailableAlias(
    parts,
    shortName,
    state.allocatedAliasKeys,
    true,
  );

  state.imports.set(alias, canonicalClassName);
  state.canonicalClassesByKey.set(classNameKey, canonicalClassName);
  addClassShortName(state.classNamesByShortName, canonicalClassName);
  state.allocatedAliasKeys.add(alias.toLowerCase());

  return alias;
}

export function renderUseStatements(registry: ImportRegistry): readonly string[] {
  const state = registryState(registry);

  return [...state.imports.entries()]
    .map(([alias, fullyQualifiedClassName]) => {
      const shortName = fullyQualifiedClassName.split("\\").at(-1);

      return alias === shortName
        ? `use ${fullyQualifiedClassName};`
        : `use ${fullyQualifiedClassName} as ${alias};`;
    })
    .sort();
}

function normalizeReservedNames(reservedNames: Iterable<string>): ReadonlySet<string> {
  const normalizedNames = new Set<string>();
  const namesByKey = new Map<string, string>();

  for (const reservedName of reservedNames) {
    assertValidLocalName(reservedName, `Invalid reserved PHP name "${reservedName}"`);
    const nameKey = reservedName.toLowerCase();
    const existingName = namesByKey.get(nameKey);

    if (existingName !== undefined && existingName !== reservedName) {
      throw new Error(
        `Case-insensitive reserved PHP name collision: ${existingName} and ${reservedName}.`,
      );
    }

    namesByKey.set(nameKey, reservedName);
    normalizedNames.add(reservedName);
  }

  return normalizedNames;
}

function normalizePlannedImports(plannedImports: Iterable<string>): readonly string[] {
  const classNamesByKey = new Map<string, string>();

  for (const plannedImport of plannedImports) {
    const canonicalClassName = canonicalFullyQualifiedClassName(plannedImport);
    const classNameKey = canonicalClassName.toLowerCase();
    const existingClassName = classNamesByKey.get(classNameKey);

    if (existingClassName !== undefined && existingClassName !== canonicalClassName) {
      throwCaseInsensitiveClassError(existingClassName, canonicalClassName);
    }

    classNamesByKey.set(classNameKey, canonicalClassName);
  }

  return [...classNamesByKey.values()].sort(compareCanonicalNames);
}

function planAliases(
  canonicalClassNames: readonly string[],
  reservedNameKeys: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const classNamesByShortName = new Map<string, string[]>();

  for (const fullyQualifiedClassName of canonicalClassNames) {
    const shortName = shortClassName(fullyQualifiedClassName);
    const group = classNamesByShortName.get(shortName.toLowerCase());

    if (group === undefined) {
      classNamesByShortName.set(shortName.toLowerCase(), [fullyQualifiedClassName]);
    } else {
      group.push(fullyQualifiedClassName);
    }
  }

  const aliasesByClass = new Map<string, string>();
  const allocatedAliasKeys = new Set(reservedNameKeys);

  for (const fullyQualifiedClassName of canonicalClassNames) {
    const shortName = shortClassName(fullyQualifiedClassName);
    const group = classNamesByShortName.get(shortName.toLowerCase()) ?? [];

    if (group.length === 1 && !allocatedAliasKeys.has(shortName.toLowerCase())) {
      aliasesByClass.set(fullyQualifiedClassName, shortName);
      allocatedAliasKeys.add(shortName.toLowerCase());
    }
  }

  for (const fullyQualifiedClassName of canonicalClassNames) {
    if (aliasesByClass.has(fullyQualifiedClassName)) {
      continue;
    }

    const parts = fullyQualifiedClassName.split("\\");
    const shortName = shortClassName(fullyQualifiedClassName);
    const alias = resolveAvailableAlias(parts, shortName, allocatedAliasKeys, false);

    aliasesByClass.set(fullyQualifiedClassName, alias);
    allocatedAliasKeys.add(alias.toLowerCase());
  }

  return aliasesByClass;
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

  const terminalClassName = parts.at(-1);

  if (terminalClassName === undefined) {
    throw new Error(`Cannot resolve the terminal class segment for ${fullyQualifiedClassName}.`);
  }

  if (isPhpReservedClassName(terminalClassName)) {
    throw new Error(
      `Invalid PHP fully qualified class name "${fullyQualifiedClassName}": terminal class segment "${terminalClassName}" is a reserved PHP class name.`,
    );
  }

  return canonicalClassName;
}

function resolveAvailableAlias(
  classNameParts: readonly string[],
  shortName: string,
  allocatedAliasKeys: ReadonlySet<string>,
  includeShortName: boolean,
): string {
  const namespaceParts = classNameParts.slice(0, -1);
  const prefixedShortName = `${shortName.charAt(0).toUpperCase()}${shortName.slice(1)}`;
  const candidates = includeShortName ? [shortName] : [];

  for (let index = namespaceParts.length - 1; index >= 0; index -= 1) {
    candidates.push(`${namespaceParts.slice(index).join("")}${prefixedShortName}`);
  }

  for (const candidate of candidates) {
    if (isAvailableAlias(candidate, allocatedAliasKeys)) {
      return candidate;
    }
  }

  const baseAlias = candidates.at(-1) ?? prefixedShortName;
  let suffix = 2;

  while (!isAvailableAlias(`${baseAlias}${suffix}`, allocatedAliasKeys)) {
    suffix += 1;
  }

  return `${baseAlias}${suffix}`;
}

function isAvailableAlias(alias: string, allocatedAliasKeys: ReadonlySet<string>): boolean {
  return PHP_IDENTIFIER.test(alias)
    && !isPhpReservedClassName(alias)
    && !allocatedAliasKeys.has(alias.toLowerCase());
}

function assertValidLocalName(localName: string, context: string): void {
  if (!PHP_IDENTIFIER.test(localName)) {
    throw new Error(
      `${context}; expected an ASCII identifier starting with a letter or underscore and containing only letters, numbers, and underscores.`,
    );
  }

  if (isPhpReservedClassName(localName)) {
    throw new Error(`${context}: reserved PHP name "${localName}" cannot be used as a class alias.`);
  }
}

function isPhpReservedClassName(className: string): boolean {
  return PHP_RESERVED_CLASS_NAMES.has(className.toLowerCase());
}

function findImportByClassName(
  imports: ReadonlyMap<string, string>,
  fullyQualifiedClassName: string,
): string | undefined {
  for (const [alias, importedClassName] of imports) {
    if (importedClassName === fullyQualifiedClassName) {
      return alias;
    }
  }

  return undefined;
}

function addClassShortName(
  classNamesByShortName: Map<string, Set<string>>,
  fullyQualifiedClassName: string,
): void {
  const shortNameKey = shortClassName(fullyQualifiedClassName).toLowerCase();
  const classNames = classNamesByShortName.get(shortNameKey);

  if (classNames === undefined) {
    classNamesByShortName.set(shortNameKey, new Set([fullyQualifiedClassName]));
  } else {
    classNames.add(fullyQualifiedClassName);
  }
}

function shortClassName(fullyQualifiedClassName: string): string {
  const shortName = fullyQualifiedClassName.split("\\").at(-1);

  if (shortName === undefined) {
    throw new Error(`Cannot resolve the short PHP class name for ${fullyQualifiedClassName}.`);
  }

  return shortName;
}

function compareCanonicalNames(left: string, right: string): number {
  const leftKey = left.toLowerCase();
  const rightKey = right.toLowerCase();

  if (leftKey < rightKey) {
    return -1;
  }

  if (leftKey > rightKey) {
    return 1;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}

function throwCaseInsensitiveClassError(
  existingClassName: string,
  requestedClassName: string,
): never {
  throw new Error(
    `The same case-insensitive PHP class is already registered as ${existingClassName}; cannot also register ${requestedClassName}. Use one canonical class-name spelling.`,
  );
}

function registryState(registry: ImportRegistry): ImportRegistryState {
  const state = REGISTRY_STATES.get(registry);

  if (state === undefined) {
    throw new Error(
      "Invalid PHP import registry: registries must be created by createImportRegistry so import state remains validated and read-only.",
    );
  }

  return state;
}

class ReadonlyMapView<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #source: ReadonlyMap<Key, Value>;

  public constructor(source: ReadonlyMap<Key, Value>) {
    this.#source = source;
  }

  public get size(): number {
    return this.#source.size;
  }

  public get(key: Key): Value | undefined {
    return this.#source.get(key);
  }

  public has(key: Key): boolean {
    return this.#source.has(key);
  }

  public entries(): MapIterator<[Key, Value]> {
    return this.#source.entries();
  }

  public keys(): MapIterator<Key> {
    return this.#source.keys();
  }

  public values(): MapIterator<Value> {
    return this.#source.values();
  }

  public forEach(
    callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArgument?: unknown,
  ): void {
    this.#source.forEach((value, key) => {
      callback.call(thisArgument, value, key, this);
    });
  }

  public [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return "ReadonlyMap";
  }
}

class ReadonlySetView<Value> implements ReadonlySet<Value> {
  readonly #source: ReadonlySet<Value>;

  public constructor(source: ReadonlySet<Value>) {
    this.#source = source;
  }

  public get size(): number {
    return this.#source.size;
  }

  public has(value: Value): boolean {
    return this.#source.has(value);
  }

  public entries(): SetIterator<[Value, Value]> {
    return this.#source.entries();
  }

  public keys(): SetIterator<Value> {
    return this.#source.keys();
  }

  public values(): SetIterator<Value> {
    return this.#source.values();
  }

  public forEach(
    callback: (value: Value, key: Value, set: ReadonlySet<Value>) => void,
    thisArgument?: unknown,
  ): void {
    this.#source.forEach((value) => {
      callback.call(thisArgument, value, value, this);
    });
  }

  public [Symbol.iterator](): SetIterator<Value> {
    return this.values();
  }

  public get [Symbol.toStringTag](): string {
    return "ReadonlySet";
  }
}
