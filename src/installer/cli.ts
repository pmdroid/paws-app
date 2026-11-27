import { ensureLayout, loadEnv, pawsPaths, type EnvSource } from "../config";
import { defaultEnvFile } from "./env-file-path";
import { openEnvFile } from "./env-file";
import { runSecretsStep } from "./secrets";

export const INSTALL_USAGE = "usage: paws install secrets [--env-file PATH]";

/** `paws install secrets`. Returns the exit code. */
export async function runInstallCli(
  argv: readonly string[],
  source: EnvSource,
  withSecrets: (merged: EnvSource, work: () => Promise<void>) => Promise<void> = (_, work) =>
    work(),
): Promise<number> {
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
  try {
    await withSecrets(merged, async () =>
      runSecretsStep({
        home,
        prompter: { say: (text) => process.stdout.write(`${text}\n`) },
        publicUrl: merged.PAWS_PUBLIC_URL || null,
      }),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "paws install secrets failed.");
    return 1;
  }
}
