import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import {
  DEFAULT_NAMESPACE,
  PhpNamespace,
  runConfigureComposerCli,
} from "../src/index.js";

const TEST_BIN = "example-generator-bin";
const TEST_MODULE = "example-generator";
const projectPaths: string[] = [];
const TestConfig = z.strictObject({
  namespace: PhpNamespace.default(DEFAULT_NAMESPACE),
});
type TestConfig = z.infer<typeof TestConfig>;

function parseTestConfig(value: unknown): TestConfig {
  return TestConfig.parse(value);
}

function createProject(composerSource = "{}\n", module = TEST_MODULE): string {
  const projectPath = mkdtempSync(join(tmpdir(), "generator-core-composer-cli-"));
  projectPaths.push(projectPath);
  mkdirSync(join(projectPath, "generated", "skirout"), { recursive: true });
  writeFileSync(
    join(projectPath, "skir.yml"),
    [
      "generators:",
      `  - mod: ${module}`,
      "    outDir: generated/skirout",
      "",
    ].join("\n"),
  );
  writeFileSync(join(projectPath, "composer.json"), composerSource);

  return projectPath;
}

function runCli(argv: readonly string[], module = TEST_MODULE): Promise<void> {
  return runConfigureComposerCli({
    argv,
    bin: TEST_BIN,
    module,
    parseConfig: parseTestConfig,
    namespace: (config) => config.namespace,
  });
}

function captureStandardOutput(): string[] {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });

  return output;
}

afterEach(() => {
  vi.restoreAllMocks();

  for (const projectPath of projectPaths.splice(0)) {
    rmSync(projectPath, { recursive: true, force: true });
  }
});

describe("runConfigureComposerCli", () => {
  it("returns Promise<void>, adds the mapping, and prints the follow-up command", async () => {
    const projectPath = createProject();
    const output = captureStandardOutput();
    const result = runCli(["configure-composer", "--root", projectPath]);

    expectTypeOf(result).toEqualTypeOf<Promise<void>>();
    await result;

    expect(output.join("")).toBe(
      "Added Composer PSR-4 mapping Skir\\ => generated/skirout/\n"
      + "Run composer dump-autoload to refresh Composer's autoloader.\n",
    );
    expect(JSON.parse(readFileSync(join(projectPath, "composer.json"), "utf8"))
      .autoload["psr-4"]["Skir\\"]).toBe("generated/skirout/");
  });

  it("prints Unchanged for an existing equivalent mapping", async () => {
    const source = '{"autoload":{"psr-4":{"Skir\\\\":"generated/skirout/"}}}\n';
    const projectPath = createProject(source);
    const output = captureStandardOutput();

    await runCli(["configure-composer", "--root", projectPath]);

    expect(output[0]).toBe("Unchanged Composer PSR-4 mapping Skir\\ => generated/skirout/\n");
    expect(readFileSync(join(projectPath, "composer.json"), "utf8")).toBe(source);
  });

  it("uses the parameterized module and permits the established --mod override", async () => {
    const overrideModule = "alternate-generator";
    const projectPath = createProject("{}\n", overrideModule);
    captureStandardOutput();

    await runCli([
      "configure-composer",
      "--root",
      projectPath,
      "--mod",
      overrideModule,
    ]);

    expect(JSON.parse(readFileSync(join(projectPath, "composer.json"), "utf8"))
      .autoload["psr-4"]["Skir\\"]).toBe("generated/skirout/");
  });

  it.each([
    [[], `Usage: ${TEST_BIN} configure-composer [--root <dir>] [--mod <module>]`],
    [["--help"], `Usage: ${TEST_BIN} configure-composer [--root <dir>] [--mod <module>]`],
    [["other-command"], `Usage: ${TEST_BIN} configure-composer [--root <dir>] [--mod <module>]`],
    [["configure-composer", "--unknown"], `Unknown argument --unknown. Usage: ${TEST_BIN} configure-composer [--root <dir>] [--mod <module>]`],
    [["configure-composer", "--root"], "Missing value for --root."],
    [["configure-composer", "--root", "--mod", "other"], "Missing value for --root."],
    [["configure-composer", "--mod"], "Missing value for --mod."],
  ])("rejects invalid arguments without exiting the process", async (argv, message) => {
    const previousExitCode = process.exitCode;

    await expect(runCli(argv)).rejects.toThrow(message);
    expect(process.exitCode).toBe(previousExitCode);
  });

  it("awaits and propagates configuration errors without writing output", async () => {
    const source = '{"autoload":{"psr-4":{"Skir\\\\":"src/"}}}\n';
    const projectPath = createProject(source);
    const output = captureStandardOutput();

    await expect(runCli(["configure-composer", "--root", projectPath]))
      .rejects.toThrow(/conflict/i);

    expect(output).toEqual([]);
    expect(readFileSync(join(projectPath, "composer.json"), "utf8")).toBe(source);
  });
});
