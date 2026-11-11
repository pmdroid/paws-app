import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Directories under `~/.paws`. The developer's own checkout is never one of these. */
export type PawsPaths = {
  home: string;
  db: string;
  pgliteDir: string;
  configFile: string;
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
    configFile: join(home, "config.toml"),
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
    paths.reposDir,
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

const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Remove entries under `tmpDir` older than 24 hours, left behind by a process that did not finish. */
export function sweepTmpDir(paths: PawsPaths, now = Date.now()): void {
  for (const name of readdirSync(paths.tmpDir)) {
    const entry = join(paths.tmpDir, name);
    if (now - lstatSync(entry).mtimeMs > TMP_MAX_AGE_MS)
      rmSync(entry, { recursive: true, force: true });
  }
}
