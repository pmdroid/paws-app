import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const STALE_WITHOUT_PID_MS = 6 * 60 * 60 * 1000;

function pidNamespace(): string | undefined {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sweepStaleRoots(parent: string, now = Date.now()): void {
  const namespace = pidNamespace();
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
      let recordedNamespace: string | undefined;
      try {
        const [recordedPid, ns] = readFileSync(join(dir, ".pid"), "utf8").trim().split(/\s+/);
        pid = Number.parseInt(recordedPid ?? "", 10);
        recordedNamespace = ns;
      } catch {}
      // PIDs are comparable only within the same known namespace.
      const stale =
        pid && pid > 0 && namespace && recordedNamespace === namespace
          ? !alive(pid)
          : now - stat.mtimeMs > STALE_WITHOUT_PID_MS;
      if (stale) rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

const parent = process.env.TMPDIR || "/tmp";
sweepStaleRoots(parent);
const root = mkdtempSync(join(parent, "pt-"));
const namespace = pidNamespace();
writeFileSync(join(root, ".pid"), `${process.pid}${namespace ? ` ${namespace}` : ""}`);
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
