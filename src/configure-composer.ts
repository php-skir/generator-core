import {
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { parse } from "yaml";

import {
  ensureComposerPsr4Mapping,
  type ComposerPsr4MappingResult,
} from "./composer-autoload.js";

export interface ConfigureComposerOptions<Config> {
  readonly module: string;
  readonly root?: string;
  readonly parseConfig: (value: unknown) => Config;
  readonly namespace: (config: Config) => string;
}

interface SkirGeneratorEntry {
  readonly config?: unknown;
  readonly mod?: unknown;
  readonly outDir?: unknown;
}

export async function configureComposer<Config>(
  options: ConfigureComposerOptions<Config>,
): Promise<ComposerPsr4MappingResult> {
  const root = resolve(options.root ?? process.cwd());
  const skirConfigPath = join(root, "skir.yml");
  const composerPath = join(root, "composer.json");
  const skirSource = await readRequiredFile(skirConfigPath, "skir.yml");
  const composerSource = await readRequiredFile(composerPath, "composer.json");
  const generator = findGenerator(skirSource, options.module);
  const outDirs = parseOutDirs(generator.outDir, options.module);
  const generatorConfig = parseGeneratorConfig(
    generator.config,
    options.module,
    options.parseConfig,
  );
  const composerPaths = await validateOutputDirectories(root, outDirs);
  const result = ensureComposerPsr4Mapping(
    composerSource,
    options.namespace(generatorConfig),
    typeof generator.outDir === "string" ? composerPaths[0]! : composerPaths,
  );

  if (!result.changed) {
    return result;
  }

  await writeAtomically(composerPath, result.source);

  return result;
}

async function readRequiredFile(path: string, name: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`${name} was not found at ${path}.`);
    }

    throw new Error(`Unable to read ${name} at ${path}: ${errorMessage(error)}`);
  }
}

function findGenerator(source: string, module: string): SkirGeneratorEntry {
  let config: unknown;

  try {
    config = parse(source);
  } catch (error) {
    throw new Error(`Invalid skir.yml: ${errorMessage(error)}`);
  }

  if (!isObject(config)) {
    throw new Error("Invalid skir.yml: the root value must be an object.");
  }

  if (!Array.isArray(config.generators)) {
    throw new Error("Invalid skir.yml: generators must be an array.");
  }

  const generator = config.generators.find((entry: unknown) => {
    return isObject(entry) && entry.mod === module;
  });

  if (!isObject(generator)) {
    throw new Error(`Generator ${module} was not found in skir.yml.`);
  }

  return generator;
}

function parseOutDirs(value: unknown, module: string): readonly string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((path): path is string => {
      return typeof path === "string" && path.length > 0;
    })) {
      return value;
    }
  }

  throw new Error(`Invalid skir.yml generator ${module}: outDir must be a string or non-empty array of strings.`);
}

function parseGeneratorConfig<Config>(
  value: unknown,
  module: string,
  parseConfig: (value: unknown) => Config,
): Config {
  try {
    return parseConfig(value ?? {});
  } catch (error) {
    throw new Error(`Invalid skir.yml generator ${module} config: ${errorMessage(error)}`);
  }
}

async function validateOutputDirectories(
  root: string,
  outDirs: readonly string[],
): Promise<readonly string[]> {
  const canonicalRoot = await realpath(root);
  const composerPaths: string[] = [];

  for (const outDir of outDirs) {
    const filesystemPath = normalizeFilesystemPath(outDir);
    const outputPath = resolve(root, filesystemPath);
    ensureContainedPath(root, outputPath, outDir);
    await ensureExistingAncestorContained(canonicalRoot, outputPath, outDir);

    let outputStat: Awaited<ReturnType<typeof stat>>;

    try {
      outputStat = await stat(outputPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`Generated output directory ${outDir} does not exist. Run Skir generation first.`);
      }

      throw new Error(`Unable to inspect generated output directory ${outDir}: ${errorMessage(error)}`);
    }

    if (!outputStat.isDirectory()) {
      throw new Error(`Generated output path ${outDir} is not a directory.`);
    }

    const canonicalOutputPath = await realpath(outputPath);
    ensureContainedPath(canonicalRoot, canonicalOutputPath, outDir);
    composerPaths.push(relative(root, outputPath).replaceAll("\\", "/"));
  }

  return composerPaths;
}

function normalizeFilesystemPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");

  if (/^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`Generated output directory ${path} escapes the project root.`);
  }

  return normalized;
}

async function ensureExistingAncestorContained(
  canonicalRoot: string,
  path: string,
  configuredPath: string,
): Promise<void> {
  let candidate = path;

  while (true) {
    try {
      const canonicalCandidate = await realpath(candidate);
      ensureContainedPath(canonicalRoot, canonicalCandidate, configuredPath);

      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    const parent = dirname(candidate);

    if (parent === candidate) {
      throw new Error(`Unable to resolve generated output directory ${configuredPath}.`);
    }

    candidate = parent;
  }
}

function ensureContainedPath(root: string, path: string, configuredPath: string): void {
  const relativePath = relative(root, path);

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Generated output directory ${configuredPath} escapes the project root.`);
  }
}

async function writeAtomically(path: string, source: string): Promise<void> {
  const metadata = await stat(path);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(temporaryPath, source, {
      encoding: "utf8",
      flag: "wx",
      mode: metadata.mode,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error(`Unable to update composer.json atomically: ${errorMessage(error)}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
