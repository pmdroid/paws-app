import { existsSync, readFileSync } from "node:fs";

const REFUSING_SYSCTLS = [
  ["/proc/sys/user/max_user_namespaces", "0"],
  ["/proc/sys/kernel/unprivileged_userns_clone", "0"],
  ["/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "1"],
] as const;

function readSysctl(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

export function helperSandboxFailure(
  account: { name: string; uid: number },
  host: { exists?: (path: string) => boolean; read?: (path: string) => string | null } = {},
): string | null {
  const exists = host.exists ?? existsSync;
  const read = host.read ?? readSysctl;
  const failures: string[] = [];
  const manager = `user.slice/user-${account.uid}.slice/user@${account.uid}.service`;
  if (![`/sys/fs/cgroup/${manager}`, `/sys/fs/cgroup/systemd/${manager}`].some(exists))
    failures.push(
      `${account.name} has no running systemd user manager; run sudo loginctl enable-linger ${account.name}.`,
    );
  const refusing = REFUSING_SYSCTLS.find(([path, value]) => read(path) === value);
  if (refusing)
    failures.push(
      `The kernel refuses unprivileged user namespaces (${refusing[0].slice("/proc/sys/".length).replaceAll("/", ".")}=${refusing[1]}).`,
    );
  return failures.length === 0
    ? null
    : `Sandboxed helper turns cannot start: ${failures.join(" ")}`;
}
