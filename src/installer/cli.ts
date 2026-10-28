import { closeSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureLayout, loadConfigFile, loadEnv, pawsPaths, type EnvSource } from "../config";
import { doctorChecks, realProbe } from "../doctor";
import { ENV_FILE, installedUnit, unitPaths } from "../install-host";
import { openEnvFile } from "./env-file";
import { terminalPrompter, type PromptOutput } from "./prompt";
import { runSecretsStep } from "./secrets";

export const INSTALL_USAGE = "usage: paws install secrets [--env-file PATH]";

/** `paws install secrets`. Returns the exit code. */
export async function runInstallCli(argv: readonly string[], source: EnvSource): Promise<number> {
  const [step, flag, value, ...rest] = argv;
  if (
    step !== "secrets" ||
    rest.length > 0 ||
    (flag !== undefined && (flag !== "--env-file" || !value))
  ) {
    console.error(INSTALL_USAGE);
    return 1;
  }
  const env = openEnvFile(value ?? defaultEnvFile(source));
  const merged = { ...source, ...env.values() };
  const home = loadEnv(merged).home;
  const paths = pawsPaths(home);
  ensureLayout(paths);
  const config = loadConfigFile(paths.configFile);
  const terminal = openTerminal();
  try {
    await runSecretsStep({
      home,
      config,
      env,
      prompter: terminalPrompter(process.stdin, process.stdout, terminal),
      publicUrl: merged.PAWS_PUBLIC_URL || config.publicUrl,
      doctor: async () =>
        doctorChecks(await realProbe({ ...source, ...env.values(), PAWS_HOME: home })),
    });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "paws install secrets failed.");
    return 1;
  } finally {
    terminal?.close();
  }
}

/** The env file `paws install` wrote: the user unit's `EnvironmentFile`, else `PAWS_HOME/https.env`. */
export function defaultEnvFile(source: EnvSource): string {
  const installed = installedUnit(unitPaths(source.HOME || homedir(), source.XDG_CONFIG_HOME));
  return installed.envFile ?? join(loadEnv(source).home, ENV_FILE);
}

function openTerminal(): (PromptOutput & { close(): void }) | null {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "w");
  } catch {
    return null;
  }
  return {
    write: (text: string) => writeSync(fd, text),
    close: () => closeSync(fd),
  };
}
