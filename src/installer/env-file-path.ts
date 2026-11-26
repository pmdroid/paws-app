import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv, type EnvSource } from "../config";

export function defaultEnvFile(source: EnvSource): string {
  const dir = join(
    source.XDG_CONFIG_HOME || join(source.HOME || homedir(), ".config"),
    "systemd",
    "user",
  );
  const unit = join(dir, "paws.service");
  const text = existsSync(unit) ? readFileSync(unit, "utf8") : "";
  return (
    /^EnvironmentFile=-?(.+)$/m.exec(text)?.[1]?.trim() ?? join(loadEnv(source).home, "https.env")
  );
}
