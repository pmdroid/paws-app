import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const mode = process.argv[2] ?? "run";
const timeoutMs = Number(process.env.PAWS_VERIFY_TIMEOUT_MS ?? 1_800_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000)
  throw new Error("PAWS_VERIFY_TIMEOUT_MS must be between 1000 and 1800000.");
if (!["run", "--check"].includes(mode))
  throw new Error("Usage: bun --no-env-file scripts/verify-onboarding.ts [--check]");
const repo = realpathSync(resolve(import.meta.dir, ".."));
const configured = process.env.PAWS_FINEAR_ROOT;
if (!configured)
  throw new Error("Set PAWS_FINEAR_ROOT to a Finear checkout with installed dependencies.");
const finear = realpathSync(configured);
if (!existsSync(join(finear, "src/application.ts")))
  throw new Error("PAWS_FINEAR_ROOT has no src/application.ts.");
const bun = realpathSync(process.execPath);
const nodePath = process.env.PAWS_NODE_BINARY ?? Bun.which("node");
if (!nodePath) throw new Error("Node 24.21.0 is required.");
const node = realpathSync(nodePath);
const version = Bun.spawnSync([node, "--version"], {
  env: { PATH: "/usr/bin:/bin" },
  stdout: "pipe",
  stderr: "pipe",
});
if (Bun.version !== "1.4.2" || version.stdout.toString().trim() !== "v24.21.0")
  throw new Error("Use direct Bun 1.4.2 and Node 24.21.0 binaries.");
const root = realpathSync(
  mkdtempSync(join(realpathSync(process.env.PAWS_VERIFY_TMPDIR ?? "/var/tmp"), "paws-onboarding-")),
);
const home = join(root, "home");
const kyoto = join(home, ".kyotoagent");
const tmp = join(root, "tmp");
const fs = join(root, "fs");
for (const path of [home, kyoto, tmp, join(root, "paws")]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path || !path.startsWith(root + "/"))
    throw new Error("Verification paths escaped their fresh directory.");
}
for (const path of ["usr", "bin", "lib", "lib64", "home", "tmp", "var/tmp", "dev", "proc", "etc"])
  mkdirSync(join(fs, path), { recursive: true, mode: 0o755 });
const env = {
  HOME: home,
  KYOTOAGENT_ROOT: kyoto,
  PAWS_HOME: join(root, "paws"),
  TMPDIR: tmp,
  PATH: `${dirname(bun)}:${dirname(node)}:/usr/bin:/bin`,
  PAWS_FINEAR_ROOT: finear,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/no-secret-service`,
};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function hashes(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true }).flatMap((entry): [string, string][] => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? Object.entries(hashes(path))
        : entry.isFile()
          ? [[path.slice(repo.length + 1), hash(readFileSync(path))]]
          : [];
    }),
  );
}
const sources = {
  ...hashes(join(repo, "src")),
  ...hashes(join(repo, "test")),
  "scripts/verify-onboarding.ts": hash(readFileSync(import.meta.path)),
};
const revision = (cwd: string) => {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
};
writeFileSync(
  join(root, "manifest.json"),
  JSON.stringify(
    {
      mode,
      repo,
      finear,
      root,
      home,
      kyoto,
      bun,
      node,
      base: revision(repo),
      finearBase: revision(finear),
      sources,
    },
    null,
    2,
  ),
);
const preflight = `import { existsSync, readFileSync, statSync, statfsSync } from "node:fs";
const paths = JSON.parse(process.argv[1]);
for (const path of paths) if (!existsSync(path)) throw new Error("Namespace path unavailable: " + path);
if (statSync("/").uid !== 0 || statfsSync("/etc").type !== 0x01021994) throw new Error("Disposable root filesystem unavailable");
const interfaces = readFileSync("/proc/self/net/dev", "utf8").split("\\n").slice(2).map(line => line.split(":")[0].trim()).filter(Boolean);
if (interfaces.join(",") !== "lo") throw new Error("Network namespace is not loopback-only");
const lookup = Bun.spawnSync(["getent", "hosts", "github.com"]).stdout.toString().trim().split(/\\s+/)[0];
if (lookup !== "127.0.0.1") throw new Error("GitHub is not namespace-local");
console.log(JSON.stringify({ passed: true, interfaces, github: lookup, paths }));`;
const namespace = `set -eu
FS=$1
REPO=$2
FINEAR=$3
shift 3
/usr/sbin/ip link set lo up
mount --make-rprivate /
for path in /usr /bin /lib /lib64 /home /tmp /var/tmp /dev /proc; do mount --rbind "$path" "$FS$path"; done
for path in "$REPO" "$FINEAR"; do mkdir -p "$FS$path"; mount --bind "$path" "$FS$path"; done
mount -t tmpfs -o mode=0755 tmpfs "$FS/etc"
mkdir -p "$FS/etc/ssl"
mount --bind /etc/ssl "$FS/etc/ssl"
mount -o remount,bind,ro "$FS/etc/ssl"
printf "127.0.0.1 localhost github.com\\n::1 localhost\\n" > "$FS/etc/hosts"
printf "root:x:0:\\npaws-runner:x:0:\\n" > "$FS/etc/group"
mount -t proc proc "$FS/proc"
exec /usr/bin/chroot "$FS" "$@"`;
const args =
  mode === "--check"
    ? [
        "--eval",
        preflight,
        JSON.stringify([
          bun,
          node,
          home,
          kyoto,
          tmp,
          join(repo, "test/local/onboarding-e2e.ts"),
          join(finear, "src/application.ts"),
          "/etc/ssl/openssl.cnf",
        ]),
      ]
    : [join(repo, "test/local/onboarding-e2e.ts"), root];
console.log(`Isolated onboarding ${mode}: ${root}`);
const child = Bun.spawn(
  [
    "/usr/bin/unshare",
    "--user",
    "--map-root-user",
    "--net",
    "--mount",
    "--pid",
    "--fork",
    "--kill-child=KILL",
    "/bin/bash",
    "-c",
    namespace,
    "isolate",
    fs,
    repo,
    finear,
    "/usr/bin/env",
    "-i",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    bun,
    "--no-env-file",
    "--cwd",
    repo,
    ...args,
  ],
  { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
);
const log = Bun.file(join(root, "probe.log")).writer();
async function copy(stream: ReadableStream<Uint8Array>) {
  for await (const chunk of stream) {
    log.write(chunk);
    process.stdout.write(chunk);
  }
}
let interrupted: string | null = null;
let escalation: ReturnType<typeof setTimeout> | undefined;
const stop = (reason: string) => {
  if (interrupted) return;
  interrupted = reason;
  writeFileSync(join(root, "cancel.json"), JSON.stringify({ reason }));
  escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }, 40_000);
};
const onInterrupt = () => stop("SIGINT");
const onTerminate = () => stop("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
const timer = setTimeout(() => stop("deadline"), timeoutMs);
const [exit] = await Promise.all([child.exited, copy(child.stdout), copy(child.stderr)]);
clearTimeout(timer);
clearTimeout(escalation);
process.off("SIGINT", onInterrupt);
process.off("SIGTERM", onTerminate);
await log.end();
writeFileSync(
  join(root, "command.json"),
  JSON.stringify({ mode, pid: child.pid, exit, signal: child.signalCode, interrupted }, null, 2),
);
console.log(`Evidence retained: ${root}; exit=${exit}`);
process.exitCode = interrupted ? 1 : exit;
