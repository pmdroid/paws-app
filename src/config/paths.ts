import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Directories under `~/.paws`. The developer's own checkout is never one of these. */
export type PawsPaths = {
  home: string;
  db: string;
  configFile: string;
  secretsDir: string;
  reposDir: string;
  worktreesDir: string;
  runsDir: string;
  logsDir: string;
  /** Closeout videos and screenshots, one file per `evidence` row. */
  evidenceDir: string;
};

export function pawsPaths(home: string): PawsPaths {
  return {
    home,
    db: join(home, "paws.db"),
    configFile: join(home, "config.toml"),
    secretsDir: join(home, "secrets"),
    reposDir: join(home, "repos"),
    worktreesDir: join(home, "worktrees"),
    runsDir: join(home, "runs"),
    logsDir: join(home, "logs"),
    evidenceDir: join(home, "evidence"),
  };
}

/** Create the home layout. Secrets stay mode 0700; this does not write secret files. */
export function ensureLayout(paths: PawsPaths): void {
  const dirs = [
    paths.home,
    paths.secretsDir,
    paths.reposDir,
    paths.worktreesDir,
    paths.runsDir,
    paths.logsDir,
    paths.evidenceDir,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}
