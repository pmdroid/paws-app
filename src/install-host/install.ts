import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ensureLayout,
  parseConfigToml,
  pawsPaths,
  type EnvSource,
} from "../config";
import {
  ANSWER_KEYS,
  FIELDS,
  NONE,
  isAnswerKey,
  parseAnswersFile,
  toAnswers,
  type AnswerKey,
  type RawAnswers,
} from "./answers";
import {
  ENV_FILE,
  installedUnit,
  parseEnvFile,
  readText,
  renderConfig,
  renderDropIn,
  renderEnvFile,
  renderUnit,
  unitPaths,
  writeIfChanged,
} from "./files";

export const BUN_VERSION = "1.4.2";
export const MISE_BUN_COMMAND = `mise use -g bun@${BUN_VERSION}`;
export const DEFAULT_CHECKOUT = "~/.local/share/paws/app";
const DEFAULT_RUNNER_PORT = "8788";

export type Prompt = {
  /** One question. An empty answer means the default. */
  ask(question: string, defaultValue: string): Promise<string>;
  close?(): void;
};

export type BunInfo = { version: string; path: string };

export type InstallHostDeps = {
  /** The user's home directory. */
  home: string;
  env: EnvSource;
  /** Null for `--non-interactive`. */
  prompt: Prompt | null;
  findBun(): Promise<BunInfo | null>;
  systemctl(args: string[]): Promise<number>;
  out(line: string): void;
};

export type InstallArgs = {
  nonInteractive: boolean;
  answersFile: string | null;
  values: RawAnswers;
  help: boolean;
};

export const INSTALL_HELP = `usage: paws install [--non-interactive] [--answers <file.toml>] [--<key> <value>]...

Writes PAWS_HOME/${ENV_FILE}, config.toml and the systemd user unit, then reloads systemd.
Keys: ${ANSWER_KEYS.map((key) => key.replaceAll("_", "-")).join(", ")}.
An answers file uses the same keys with underscores. Flags override it.`;

export function parseInstallArgs(argv: readonly string[]): InstallArgs {
  const args: InstallArgs = { nonInteractive: false, answersFile: null, values: {}, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--non-interactive") {
      args.nonInteractive = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unknown argument ${arg}.`);
    const name = match[1]!;
    const value = match[2] ?? argv[++index];
    if (value === undefined) throw new Error(`--${name} needs a value.`);
    const key = name.replaceAll("-", "_");
    if (key === "answers") args.answersFile = value;
    else if (isAnswerKey(key)) args.values[key] = value;
    else throw new Error(`Unknown option --${name}.`);
  }
  return args;
}

/** `paws install`. Returns the process exit code. */
export async function runInstall(args: InstallArgs, deps: InstallHostDeps): Promise<number> {
  if (args.help) {
    deps.out(INSTALL_HELP);
    return 0;
  }
  const bun = await deps.findBun();
  if (bun === null || bun.version !== BUN_VERSION) {
    deps.out(
      `Paws needs bun ${BUN_VERSION} on PATH${bun === null ? "" : `, found ${bun.version}`}. Install it with:\n  ${MISE_BUN_COMMAND}`,
    );
    return 1;
  }
  const given: RawAnswers = {
    ...(args.answersFile === null ? {} : parseAnswersFile(readFileSync(args.answersFile, "utf8"))),
    ...args.values,
  };
  const units = unitPaths(deps.home, deps.env.XDG_CONFIG_HOME);
  const installed = installedUnit(units);
  const raw: RawAnswers = {};
  const resolve = async (key: AnswerKey, current: string) => {
    raw[key] = await answer(key, current, given[key], raw, deps);
  };

  await resolve("checkout", installed.checkout ?? DEFAULT_CHECKOUT);
  await resolve(
    "paws_home",
    installed.envFile ? dirname(installed.envFile) : (deps.env.PAWS_HOME ?? "~/.paws"),
  );
  const paths = pawsPaths(raw.paws_home!);
  const envPath = join(paths.home, ENV_FILE);
  const envText = readText(envPath);
  const envNow = parseEnvFile(envText);
  const configText = readText(paths.configFile);
  const configNow = configText ? parseConfig(configText) : null;

  await resolve("paws_host", envNow.PAWS_HOST ?? DEFAULT_HOST);
  await resolve("paws_port", envNow.PAWS_PORT ?? String(DEFAULT_PORT));
  await resolve(
    "paws_public_dashboard",
    (envNow.PAWS_PUBLIC_DASHBOARD ?? "1") === "1" ? "yes" : "no",
  );
  await resolve("paws_public_url", envNow.PAWS_PUBLIC_URL ?? configNow?.publicUrl ?? "");
  await resolve(
    "paws_runner_host",
    envNow.PAWS_RUNNER_HOST ?? (existsSync(envPath) ? "" : hostOf(raw.paws_public_url!)),
  );
  if (raw.paws_runner_host)
    await resolve("paws_runner_port", envNow.PAWS_RUNNER_PORT ?? DEFAULT_RUNNER_PORT);
  else raw.paws_runner_port = envNow.PAWS_RUNNER_PORT ?? DEFAULT_RUNNER_PORT;
  await resolve("linear_team", configNow?.linearTeam ?? "");
  await resolve(
    "github_repos",
    [configNow?.repo, ...(configNow?.githubRepos ?? [])].filter(Boolean).join(", "),
  );
  const size = configNow?.memberVm;
  await resolve("member_vm_cpu", size?.cpu === undefined ? "" : String(size.cpu));
  await resolve("member_vm_memory_gb", size?.memoryGb === undefined ? "" : String(size.memoryGb));
  await resolve("member_vm_disk_gb", size?.diskGb === undefined ? "" : String(size.diskGb));
  await resolve("member_vm_image", size?.image ?? "");
  await resolve("member_vm_pool", size?.pool ?? "");
  deps.prompt?.close?.();

  const answers = toAnswers(raw as Required<RawAnswers>);
  ensureLayout(paths);
  const config = renderConfig(configText, answers);
  const written = [
    writeIfChanged(envPath, renderEnvFile(envText, answers), 0o600) && envPath,
    (config.length > 0 || configText.length > 0) &&
      writeIfChanged(paths.configFile, config, 0o600) &&
      paths.configFile,
    writeIfChanged(units.unit, renderUnit({ envFile: envPath, bun: bun.path }), 0o644) &&
      units.unit,
    writeIfChanged(units.dropIn, renderDropIn(answers.checkout), 0o644) && units.dropIn,
  ].filter((path): path is string => typeof path === "string");
  deps.out(
    written.length === 0 ? "Nothing changed." : written.map((path) => `Wrote ${path}`).join("\n"),
  );
  if (!existsSync(join(answers.checkout, "src", "index.ts")))
    deps.out(`No Paws checkout at ${answers.checkout} yet. Clone it there before starting Paws.`);
  const reload = await deps.systemctl(["--user", "daemon-reload"]);
  if (reload !== 0) {
    deps.out(`systemctl --user daemon-reload exited ${reload}.`);
    return 1;
  }
  deps.out("Reloaded the systemd user units. The service is not started yet.");
  return 0;
}

async function answer(
  key: AnswerKey,
  current: string,
  given: string | undefined,
  raw: RawAnswers,
  deps: InstallHostDeps,
): Promise<string> {
  const field = FIELDS[key];
  const check = (value: string) =>
    field.check(field.optional && value.trim() === NONE ? "" : value, raw, deps.home);
  if (deps.prompt === null || given !== undefined) {
    try {
      return check(given ?? current);
    } catch (error) {
      throw new Error(`${key}: ${message(error)}`, { cause: error });
    }
  }
  const hint = field.optional ? ` (${NONE} for none)` : "";
  for (;;) {
    const typed = (await deps.prompt.ask(`${field.question}${hint}`, current)).trim();
    try {
      return check(typed === "" ? current : typed);
    } catch (error) {
      deps.out(`  ${message(error)}`);
    }
  }
}

function parseConfig(text: string) {
  try {
    return parseConfigToml(text);
  } catch (error) {
    throw new Error(`config.toml: ${message(error)}`, { cause: error });
  }
}

function hostOf(url: string): string {
  if (!url) return "";
  return new URL(url).hostname.replace(/^\[|\]$/g, "");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The real dependencies: a terminal prompt, `bun` on PATH and `systemctl`. */
export function realInstallHostDeps(nonInteractive: boolean): InstallHostDeps {
  const home = homedir();
  return {
    home,
    env: process.env,
    prompt: nonInteractive ? null : terminalPrompt(),
    async findBun() {
      try {
        const child = Bun.spawn(
          ["bun", "--print", "JSON.stringify([Bun.version, process.execPath])"],
          { cwd: home, stdout: "pipe", stderr: "ignore", stdin: "ignore" },
        );
        const text = await new Response(child.stdout).text();
        if ((await child.exited) !== 0) return null;
        const [version, path] = JSON.parse(text) as [string, string];
        return { version, path };
      } catch {
        return null;
      }
    },
    async systemctl(args) {
      try {
        return await Bun.spawn(["systemctl", ...args], { stdout: "inherit", stderr: "inherit" })
          .exited;
      } catch {
        return 127;
      }
    },
    out: (line) => console.log(line),
  };
}

function terminalPrompt(): Prompt {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (question, defaultValue) =>
      rl.question(defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `),
    close: () => rl.close(),
  };
}

/** `paws install` from the command line. */
export async function installHostMain(argv: readonly string[]): Promise<number> {
  let args: InstallArgs;
  try {
    args = parseInstallArgs(argv);
  } catch (error) {
    console.error(`${message(error)}\n${INSTALL_HELP}`);
    return 1;
  }
  const deps = realInstallHostDeps(args.nonInteractive);
  try {
    return await runInstall(args, deps);
  } catch (error) {
    console.error(`paws install failed: ${message(error)}`);
    return 1;
  } finally {
    deps.prompt?.close?.();
  }
}

/** Answers in order. Records every question it was asked. */
export function fakePrompt(answers: readonly string[]): Prompt & { questions: string[] } {
  const queue = [...answers];
  const questions: string[] = [];
  return {
    questions,
    async ask(question) {
      questions.push(question);
      const next = queue.shift();
      if (next === undefined) throw new Error(`fakePrompt has no answer for ${question}`);
      return next;
    },
  };
}

/** A fake `systemctl` that records its calls and returns `code`. */
export function fakeSystemctl(code = 0): ((args: string[]) => Promise<number>) & {
  calls: string[][];
} {
  const calls: string[][] = [];
  return Object.assign(
    async (args: string[]) => {
      calls.push(args);
      return code;
    },
    { calls },
  );
}
