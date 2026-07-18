import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystemControl = vi.hoisted((): {
  beforeComposerRevalidation: (() => void) | undefined;
  composerReadCount: number;
  renameError: Error | undefined;
} => ({
  beforeComposerRevalidation: undefined,
  composerReadCount: 0,
  renameError: undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...original,
    readFile: async (...arguments_: Parameters<typeof original.readFile>) => {
      const [path] = arguments_;

      if (String(path).endsWith(`${sep}composer.json`)) {
        filesystemControl.composerReadCount += 1;

        if (filesystemControl.composerReadCount === 2) {
          const beforeComposerRevalidation = filesystemControl.beforeComposerRevalidation;
          filesystemControl.beforeComposerRevalidation = undefined;
          beforeComposerRevalidation?.();
        }
      }

      return original.readFile(...arguments_);
    },
    rename: async (...arguments_: Parameters<typeof original.rename>) => {
      if (filesystemControl.renameError !== undefined) {
        throw filesystemControl.renameError;
      }

      return original.rename(...arguments_);
    },
  };
});

import {
  configureComposer,
  DEFAULT_NAMESPACE,
  PhpNamespace,
} from "../src/index.js";

const TEST_MODULE = "example-generator";
const projectPaths: string[] = [];

const TestConfig = z.strictObject({
  namespace: PhpNamespace.default(DEFAULT_NAMESPACE),
});
type TestConfig = z.infer<typeof TestConfig>;

function parseTestConfig(value: unknown): TestConfig {
  return TestConfig.parse(value);
}

function createProject(): string {
  const projectPath = mkdtempSync(join(tmpdir(), "generator-core-composer-config-"));
  projectPaths.push(projectPath);

  return projectPath;
}

function writeSkirConfig(projectPath: string, lines: readonly string[] = [
  "generators:",
  `  - mod: ${TEST_MODULE}`,
  "    outDir: generated/skirout",
  "",
]): void {
  writeFileSync(join(projectPath, "skir.yml"), lines.join("\n"));
}

function createSymlink(target: string, path: string, type: "dir" | "file"): boolean {
  try {
    symlinkSync(
      target,
      path,
      process.platform === "win32" && type === "dir" ? "junction" : type,
    );

    return true;
  } catch (error) {
    if (isUnsupportedSymlinkError(error)) {
      return false;
    }

    throw error;
  }
}

function isUnsupportedSymlinkError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return error.code === "EACCES"
    || error.code === "EPERM"
    || error.code === "ENOTSUP";
}

function configureTestComposer(projectPath?: string, module = TEST_MODULE) {
  return configureComposer({
    module,
    ...(projectPath === undefined ? {} : { root: projectPath }),
    parseConfig: parseTestConfig,
    namespace: (config) => config.namespace,
  });
}

beforeEach(() => {
  filesystemControl.beforeComposerRevalidation = undefined;
  filesystemControl.composerReadCount = 0;
  filesystemControl.renameError = undefined;
});

afterEach(() => {
  for (const projectPath of projectPaths.splice(0)) {
    rmSync(projectPath, { recursive: true, force: true });
  }
});

describe("configureComposer", () => {
  it("reports a missing composer.json", async () => {
    const projectPath = createProject();
    writeSkirConfig(projectPath);

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/composer\.json.*not found/i);
  });

  it("reports a missing skir.yml", async () => {
    const projectPath = createProject();
    writeFileSync(join(projectPath, "composer.json"), "{}\n");

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/skir\.yml.*not found/i);
  });

  it("uses the current working directory when root is omitted", async () => {
    const projectPath = createProject();
    const originalWorkingDirectory = process.cwd();
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(join(projectPath, "composer.json"), "{}\n");

    try {
      process.chdir(projectPath);
      const result = await configureTestComposer();

      expect(result.changed).toBe(true);
    } finally {
      process.chdir(originalWorkingDirectory);
    }
  });

  it("requires every generated output directory before writing Composer", async () => {
    const projectPath = createProject();
    const source = "{}\n";
    writeSkirConfig(projectPath, [
      "generators:",
      `  - mod: ${TEST_MODULE}`,
      "    outDir:",
      "      - generated/primary",
      "      - generated/fallback",
      "",
    ]);
    writeFileSync(join(projectPath, "composer.json"), source);
    mkdirSync(join(projectPath, "generated", "primary"), { recursive: true });

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/generated\/fallback.*does not exist/i);
    expect(readFileSync(join(projectPath, "composer.json"), "utf8")).toBe(source);
  });

  it("adds the default mapping atomically and is idempotent", async () => {
    const projectPath = createProject();
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(join(projectPath, "composer.json"), '{\n  "require": {}\n}\n');

    const added = await configureTestComposer(projectPath);
    const afterAdded = readFileSync(join(projectPath, "composer.json"), "utf8");
    const unchanged = await configureTestComposer(projectPath);

    expect(added).toMatchObject({
      changed: true,
      namespace: "Skir\\",
      paths: "generated/skirout/",
    });
    expect(unchanged.changed).toBe(false);
    expect(readFileSync(join(projectPath, "composer.json"), "utf8")).toBe(afterAdded);
    expect(JSON.parse(afterAdded).autoload["psr-4"]["Skir\\"])
      .toBe("generated/skirout/");
  });

  it("uses the supplied strict parser and namespace callback", async () => {
    const projectPath = createProject();
    const receivedValues: unknown[] = [];
    writeSkirConfig(projectPath, [
      "generators:",
      `  - mod: ${TEST_MODULE}`,
      "    outDir: generated/skirout",
      "    config:",
      '      namespace: "Company\\\\Contracts"',
      "",
    ]);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(join(projectPath, "composer.json"), "{}\n");

    const result = await configureComposer({
      module: TEST_MODULE,
      root: projectPath,
      parseConfig: (value) => {
        receivedValues.push(value);
        return parseTestConfig(value);
      },
      namespace: (config) => config.namespace,
    });

    expect(receivedValues).toEqual([{ namespace: "Company\\Contracts" }]);
    expect(result.namespace).toBe("Company\\Contracts\\");
  });

  it("passes an empty object to the parser when generator config is absent", async () => {
    const projectPath = createProject();
    const receivedValues: unknown[] = [];
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(join(projectPath, "composer.json"), "{}\n");

    await configureComposer({
      module: TEST_MODULE,
      root: projectPath,
      parseConfig: (value) => {
        receivedValues.push(value);
        return parseTestConfig(value);
      },
      namespace: (config) => config.namespace,
    });

    expect(receivedValues).toEqual([{}]);
  });

  it("wraps parser rejection with generator context without modifying composer.json", async () => {
    const projectPath = createProject();
    const source = '{\n  "require": {}\n}\n';
    writeSkirConfig(projectPath, [
      "generators:",
      `  - mod: ${TEST_MODULE}`,
      "    outDir: generated/skirout",
      "    config:",
      "      unexpected: true",
      "",
    ]);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(join(projectPath, "composer.json"), source);

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/invalid skir\.yml generator example-generator config/i);
    expect(readFileSync(join(projectPath, "composer.json"), "utf8")).toBe(source);
  });

  it("rejects a malformed namespace returned by the target callback", async () => {
    const projectPath = createProject();
    const source = "{}\n";
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(join(projectPath, "composer.json"), source);

    await expect(configureComposer({
      module: TEST_MODULE,
      root: projectPath,
      parseConfig: () => ({ namespace: "ignored" }),
      namespace: () => " Skir",
    })).rejects.toThrow(/canonical PHP namespace/i);
    expect(readFileSync(join(projectPath, "composer.json"), "utf8")).toBe(source);
  });

  it("does not write composer.json when the namespace conflicts", async () => {
    const projectPath = createProject();
    const source = '{\n  "autoload": {"psr-4": {"Skir\\\\": "src/"}}\n}\n';
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(join(projectPath, "composer.json"), source);

    await expect(configureTestComposer(projectPath)).rejects.toThrow(/conflict/i);
    expect(readFileSync(join(projectPath, "composer.json"), "utf8")).toBe(source);
  });

  it("validates and maps the exact configured path including whitespace", async () => {
    const projectPath = createProject();
    writeSkirConfig(projectPath, [
      "generators:",
      `  - mod: ${TEST_MODULE}`,
      '    outDir: " generated/skirout "',
      "",
    ]);
    mkdirSync(join(projectPath, " generated", "skirout "), { recursive: true });
    writeFileSync(join(projectPath, "composer.json"), "{}\n");

    const result = await configureTestComposer(projectPath);

    expect(result.paths).toBe(" generated/skirout /");
  });

  it.each([
    ["../outside"],
    ["/outside/skirout"],
    ["C:\\outside\\skirout"],
  ])("rejects output directory %j when it escapes the project root", async (outDir) => {
    const projectPath = createProject();
    writeSkirConfig(projectPath, [
      "generators:",
      `  - mod: ${TEST_MODULE}`,
      `    outDir: '${outDir}'`,
      "",
    ]);
    writeFileSync(join(projectPath, "composer.json"), "{}\n");

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/escapes.*root/i);
  });

  it("rejects output directory symlinks that escape the project root", async (context) => {
    const projectPath = createProject();
    const outsidePath = createProject();
    writeSkirConfig(projectPath, [
      "generators:",
      `  - mod: ${TEST_MODULE}`,
      "    outDir: linked-skirout",
      "",
    ]);
    writeFileSync(join(projectPath, "composer.json"), "{}\n");
    if (!createSymlink(outsidePath, join(projectPath, "linked-skirout"), "dir")) {
      context.skip();
      return;
    }

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/escapes.*root/i);
  });

  it("rejects a nonexistent output leaf below a symlink escaping the root", async (context) => {
    const projectPath = createProject();
    const outsidePath = createProject();
    writeSkirConfig(projectPath, [
      "generators:",
      `  - mod: ${TEST_MODULE}`,
      "    outDir: linked/missing-skirout",
      "",
    ]);
    writeFileSync(join(projectPath, "composer.json"), "{}\n");
    if (!createSymlink(outsidePath, join(projectPath, "linked"), "dir")) {
      context.skip();
      return;
    }

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/escapes.*root/i);
  });

  it("allows an output symlink whose canonical target remains inside the root", async (context) => {
    const projectPath = createProject();
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    if (!createSymlink(
      join(projectPath, "generated", "skirout"),
      join(projectPath, "linked-skirout"),
      "dir",
    )) {
      context.skip();
      return;
    }
    writeSkirConfig(projectPath, [
      "generators:",
      `  - mod: ${TEST_MODULE}`,
      "    outDir: linked-skirout",
      "",
    ]);
    writeFileSync(join(projectPath, "composer.json"), "{}\n");

    const result = await configureTestComposer(projectPath);

    expect(result.paths).toBe("linked-skirout/");
  });

  it("rejects an output path that is a file", async () => {
    const projectPath = createProject();
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated"), { recursive: true });
    writeFileSync(join(projectPath, "generated", "skirout"), "not a directory");
    writeFileSync(join(projectPath, "composer.json"), "{}\n");

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/not a directory/i);
  });

  it.each([
    ["[]\n", /root value must be an object/i],
    ["generators: {}\n", /generators must be an array/i],
    ["generators:\n  - [\n", /invalid skir\.yml/i],
    [`generators:\n  - mod: another-generator\n    outDir: generated/skirout\n`, /generator.*example-generator.*not found/i],
    [`generators:\n  - mod: ${TEST_MODULE}\n    outDir: []\n`, /outDir must be a string or non-empty array/i],
  ])("reports invalid generator configuration", async (skirSource, message) => {
    const projectPath = createProject();
    writeFileSync(join(projectPath, "skir.yml"), skirSource);
    writeFileSync(join(projectPath, "composer.json"), "{}\n");

    await expect(configureTestComposer(projectPath)).rejects.toThrow(message);
  });

  it.runIf(process.platform !== "win32")("preserves exact composer.json permissions despite the process umask", async () => {
    const projectPath = createProject();
    const composerPath = join(projectPath, "composer.json");
    const originalUmask = process.umask(0o022);
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(composerPath, "{}\n", { mode: 0o666 });
    chmodSync(composerPath, 0o666);

    try {
      await configureTestComposer(projectPath);
    } finally {
      process.umask(originalUmask);
    }

    expect(statSync(composerPath).mode & 0o7777).toBe(0o666);
  });

  it("rejects a symlinked composer.json without touching its link or target", async (context) => {
    const projectPath = createProject();
    const targetProjectPath = createProject();
    const composerPath = join(projectPath, "composer.json");
    const targetPath = join(targetProjectPath, "outside-composer.json");
    const source = "{}\n";
    writeFileSync(targetPath, source);
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });

    if (!createSymlink(targetPath, composerPath, "file")) {
      context.skip();
      return;
    }

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/composer\.json.*symbolic link/i);

    expect(lstatSync(composerPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(composerPath)).toBe(targetPath);
    expect(readFileSync(targetPath, "utf8")).toBe(source);
  });

  it("aborts an atomic update when composer.json changes after the initial read", async () => {
    const projectPath = createProject();
    const composerPath = join(projectPath, "composer.json");
    const concurrentSource = '{"name":"concurrent/editor"}\n';
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(composerPath, "{}\n");
    filesystemControl.beforeComposerRevalidation = () => {
      writeFileSync(composerPath, concurrentSource);
    };

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/composer\.json changed during the update/i);

    expect(readFileSync(composerPath, "utf8")).toBe(concurrentSource);
    expect(readdirSync(projectPath).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans up its temporary file when the atomic rename fails", async () => {
    const projectPath = createProject();
    const composerPath = join(projectPath, "composer.json");
    writeSkirConfig(projectPath);
    mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
    writeFileSync(composerPath, "{}\n");
    filesystemControl.renameError = Object.assign(new Error("simulated rename failure"), {
      code: "EIO",
    });

    await expect(configureTestComposer(projectPath))
      .rejects.toThrow(/unable to update composer\.json atomically.*simulated rename failure/i);

    expect(readdirSync(projectPath).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(composerPath, "utf8")).toBe("{}\n");
  });
});
