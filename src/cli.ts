import { configureComposer } from "./configure-composer.js";

export interface ConfigureComposerCliOptions<Config> {
  readonly argv: readonly string[];
  readonly bin: string;
  readonly module: string;
  readonly parseConfig: (value: unknown) => Config;
  readonly namespace: (config: Config) => string;
}

interface ParsedCliOptions {
  readonly module: string;
  readonly root: string;
}

export async function runConfigureComposerCli<Config>(
  options: ConfigureComposerCliOptions<Config>,
): Promise<void> {
  const arguments_ = parseArguments(options.argv, options.bin, options.module);
  const result = await configureComposer({
    ...arguments_,
    parseConfig: options.parseConfig,
    namespace: options.namespace,
  });
  const action = result.changed ? "Added" : "Unchanged";
  const paths = typeof result.paths === "string"
    ? result.paths
    : result.paths.join(", ");

  process.stdout.write(`${action} Composer PSR-4 mapping ${result.namespace} => ${paths}\n`);
  process.stdout.write("Run composer dump-autoload to refresh Composer's autoloader.\n");
}

function parseArguments(
  arguments_: readonly string[],
  bin: string,
  defaultModule: string,
): ParsedCliOptions {
  const usage = `Usage: ${bin} configure-composer [--root <dir>] [--mod <module>]`;

  if (arguments_[0] !== "configure-composer") {
    throw new Error(usage);
  }

  let root = process.cwd();
  let module = defaultModule;

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument !== "--root" && argument !== "--mod") {
      throw new Error(`Unknown argument ${argument}. ${usage}`);
    }

    const value = arguments_[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }

    if (argument === "--root") {
      root = value;
    }

    if (argument === "--mod") {
      module = value;
    }

    index += 1;
  }

  return { module, root };
}
