import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { githubMirrorsOn, loadSettings } from "./file";

/** Directories under `~/.paws`. The developer's own checkout is never one of these. */
export type PawsPaths = {
  home: string;
  db: string;
  pgliteDir: string;
  secretsDir: string;
  reposDir: string;
  publicationDir: string;
  worktreesDir: string;
  runsDir: string;
  logsDir: string;
  evidenceDir: string;
  /** Registered agent skill bundles, `skills/<name>/<version>/`. */
  skillsDir: string;
  /** Temporary directories for credentialed Git, on the same disk as the rest of Paws's data. */
  tmpDir: string;
};

export function pawsPaths(home: string): PawsPaths {
  return {
    home,
    db: join(home, "paws.db"),
    pgliteDir: join(home, "pglite"),
    secretsDir: join(home, "secrets"),
    reposDir: join(home, "repos"),
    publicationDir: join(home, "publication"),
    worktreesDir: join(home, "worktrees"),
    runsDir: join(home, "runs"),
    logsDir: join(home, "logs"),
    evidenceDir: join(home, "evidence"),
    skillsDir: join(home, "skills"),
    tmpDir: join(home, "tmp"),
  };
}

/** Create the home layout. Secrets stay mode 0700; this does not write secret files. */
export function ensureLayout(paths: PawsPaths): void {
  const dirs = [
    paths.home,
    paths.secretsDir,
    ...(githubMirrorsOn(loadSettings(paths.home)) ? [paths.reposDir] : []),
    paths.publicationDir,
    paths.worktreesDir,
    paths.runsDir,
    paths.logsDir,
    paths.evidenceDir,
    paths.skillsDir,
    paths.tmpDir,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}
