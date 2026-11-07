import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function throwawayEnvironment(): {
  root: string;
  home: string;
  env: Record<string, string>;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paws-verify-")));
  const home = join(root, "home");
  const kyoto = join(home, ".kyotoagent");
  for (const path of [home, kyoto, join(root, "tmp")]) mkdirSync(path, { recursive: true });
  if (realpathSync(home) !== home || realpathSync(kyoto) !== kyoto) {
    throw new Error("Verification paths must resolve inside the fresh temporary directory");
  }
  const bun = realpathSync(process.execPath);
  const env = {
    HOME: home,
    KYOTOAGENT_ROOT: kyoto,
    PAWS_HOME: join(home, ".paws"),
    PATH: `${dirname(bun)}:/usr/bin:/bin`,
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/no-secret-service`,
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${root}/no-system-service`,
    GIT_AUTHOR_NAME: "Paws Verification",
    GIT_AUTHOR_EMAIL: "paws@example.invalid",
    GIT_COMMITTER_NAME: "Paws Verification",
    GIT_COMMITTER_EMAIL: "paws@example.invalid",
    PAWS_VERIFY_ROOT: root,
  };
  return { root, home, env };
}
