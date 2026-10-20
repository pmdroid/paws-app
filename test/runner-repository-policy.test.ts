import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("protected revisioned guest publication reloads without restarting active task A when authorizing B", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-policy-namespace-"));
  try {
    for (const name of [
      "etc/paws-runner",
      "bin",
      "home/.kyotoagent",
      "fs/etc",
      "fs/usr",
      "fs/bin",
      "fs/lib",
      "fs/lib64",
      "fs/home",
      "fs/tmp",
      "fs/var/tmp",
      "fs/dev",
      "fs/proc",
    ])
      mkdirSync(join(root, name), { recursive: true });
    for (const name of ["fs", "etc", "etc/paws-runner"]) chmodSync(join(root, name), 0o755);
    writeFileSync(join(root, "etc/group"), "root:x:0:\npaws-runner:x:0:\n");
    writeFileSync(join(root, "service.log"), "");
    writeFileSync(join(root, "bin/sudo"), 'exec "$@"\n');
    writeFileSync(
      join(root, "bin/systemctl"),
      'printf "%s\\n" "$*" >> "$SERVICE_LOG"\ncase "$1" in try-restart|restart|stop) kill -TERM "$(cat "' +
        root +
        '/active.pid")";; esac\n',
    );
    chmodSync(join(root, "bin/sudo"), 0o755);
    chmodSync(join(root, "bin/systemctl"), 0o755);
    const process = Bun.spawn(
      [
        "unshare",
        "-Ur",
        "-m",
        "/bin/sh",
        "-c",
        'set -eu; for path in /usr /bin /lib /lib64 /home /tmp /var/tmp /dev /proc; do mount --rbind "$path" "$1/fs$path"; done; mount --bind "$1/etc" "$1/fs/etc"; exec chroot "$1/fs" "$2" --no-env-file "$3" "$1"',
        "fixture",
        root,
        Bun.which("bun")!,
        join(import.meta.dir, "local/repository-policy-namespace.ts"),
      ],
      {
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: join(root, "home"),
          KYOTOAGENT_ROOT: join(root, "home/.kyotoagent"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
    const observations = JSON.parse(readFileSync(join(root, "observations.json"), "utf8"));
    expect(observations.activeAauthorizeB.passed).toBe(true);
    expect(observations.revokeDoesNotCancelActiveA.passed).toBe(true);
    expect(observations.staleAndConflictingGuestWrites.passed).toBe(true);
    expect(observations.protectedBoundedNoSymlink.passed).toBe(true);
    expect(observations.stopOwnsActiveTask.passed).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
