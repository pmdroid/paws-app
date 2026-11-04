import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const STALE_WITHOUT_PID_MS = 6 * 60 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sweepStaleRoots(parent: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(parent).filter((name) => name.startsWith("pt-"));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(parent, name);
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.()) continue;
      let pid: number | undefined;
      try {
        pid = Number.parseInt(readFileSync(join(dir, ".pid"), "utf8"), 10);
      } catch {}
      const stale = pid && pid > 0 ? !alive(pid) : now - stat.mtimeMs > STALE_WITHOUT_PID_MS;
      if (stale) rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

const parent = process.env.TMPDIR || "/tmp";
sweepStaleRoots(parent);
const root = mkdtempSync(join(parent, "pt-"));
writeFileSync(join(root, ".pid"), String(process.pid));
process.env.TMPDIR = root;
const gitConfig = join(root, "gitconfig");
writeFileSync(gitConfig, "[user]\n\tname = Paws Test\n\temail = test@paws.invalid\n");
process.env.GIT_CONFIG_GLOBAL = gitConfig;
// Task runners may supply an App bot identity. Disposable test repositories use this fixture.
for (const role of ["AUTHOR", "COMMITTER"]) {
  process.env[`GIT_${role}_NAME`] = "Paws Test";
  process.env[`GIT_${role}_EMAIL`] = "test@paws.invalid";
}
const removeRoot = () => rmSync(root, { recursive: true, force: true });
process.on("exit", removeRoot);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    removeRoot();
    process.exit(128 + constants.signals[signal]);
  });
}
