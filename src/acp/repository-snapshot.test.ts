import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git";
import { decidePermission } from "./permissions";
import { prepareRepositorySnapshot } from "./repository-snapshot";

test("repository snapshots pin tracked source, preserve deliverables and keep host paths guarded", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-source-snapshot-"));
  const source = join(root, "source");
  const workspace = join(root, "task", "artifact");
  const signal = new AbortController().signal;
  try {
    await git(["init", "-b", "main", source]);
    writeFileSync(join(source, "app.txt"), "Original application");
    writeFileSync(join(root, "host-secret"), "PRIVATE");
    await symlink(join(root, "host-secret"), join(source, "escaped"));
    await git(["-C", source, "add", "."]);
    await git([
      "-C",
      source,
      "-c",
      "user.name=Paws Test",
      "-c",
      "user.email=paws@example.com",
      "commit",
      "-m",
      "Seed",
    ]);
    const original = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    writeFileSync(join(source, "untracked-secret"), "PRIVATE");
    const input = { owner: "acme", repo: "app", remoteUrl: source, workspace, signal };
    const snapshot = await prepareRepositorySnapshot(input);
    expect(snapshot.commit).toBe(original);
    expect(readFileSync(join(snapshot.path, "app.txt"), "utf8")).toBe("Original application");
    expect(existsSync(join(snapshot.path, ".git"))).toBe(false);
    expect(existsSync(join(snapshot.path, "untracked-secret"))).toBe(false);
    expect(
      decidePermission(
        { kind: "read", locations: [{ path: "repository/escaped" }] },
        { worktree: workspace, home: root, pawsRoot: join(root, "paws") },
      ).allow,
    ).toBe(false);
    writeFileSync(join(workspace, "deliverable.txt"), "Keep this output");
    writeFileSync(join(source, "app.txt"), "New source");
    await git([
      "-C",
      source,
      "-c",
      "user.name=Paws Test",
      "-c",
      "user.email=paws@example.com",
      "commit",
      "-am",
      "Change source",
    ]);
    expect(await prepareRepositorySnapshot(input)).toEqual(snapshot);
    expect(readFileSync(join(snapshot.path, "app.txt"), "utf8")).toBe("Original application");
    expect(readFileSync(join(workspace, "deliverable.txt"), "utf8")).toBe("Keep this output");
    await expect(prepareRepositorySnapshot({ ...input, repo: "other" })).rejects.toThrow(
      "ownership changed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an already stopped snapshot never creates a workspace or starts Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-source-stop-"));
  const workspace = join(root, "task");
  const controller = new AbortController();
  controller.abort();
  try {
    await expect(
      prepareRepositorySnapshot({
        owner: "acme",
        repo: "app",
        remoteUrl: "missing",
        workspace,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(existsSync(workspace)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping a source Git command joins its shell and running descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-source-git-stop-"));
  const script = join(root, "wait.js");
  const pidFile = join(root, "pid");
  const controller = new AbortController();
  let pid = 0;
  try {
    writeFileSync(
      script,
      `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const quote = (value: string) => '"' + value.replaceAll('"', '\\"') + '"';
    const pending = git(
      [
        "-c",
        `alias.paws-pause=!${quote(process.execPath)} ${quote(script)}`,
        "paws-pause",
        pidFile,
      ],
      { signal: controller.signal },
    );
    const stopped = pending.catch((error: unknown) => error);
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(5);
    expect(existsSync(pidFile)).toBe(true);
    pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    expect(await stopped).toMatchObject({ name: "AbortError" });
    const running = () => {
      try {
        return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && running(); i++) await Bun.sleep(5);
    expect(running()).toBe(false);
  } finally {
    controller.abort();
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test.skipIf(process.platform !== "linux")(
  "lost source Git ownership reports cleanup failure before returning an aborted operation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "paws-source-git-lost-"));
    const script = join(root, "wait.js");
    const marker = join(root, "owner.json");
    const controller = new AbortController();
    let pid = 0;
    let cleanupFailed = false;
    writeFileSync(
      script,
      `const fs=require("node:fs"); process.on("SIGTERM", () => {}); let anchor=process.ppid; while(!fs.readFileSync("/proc/"+anchor+"/cmdline", "utf8").includes("process-anchor.ts")) { const stat=fs.readFileSync("/proc/"+anchor+"/stat", "utf8"); anchor=Number(stat.slice(stat.lastIndexOf(")")+2).split(" ")[1]); } fs.writeFileSync(process.argv[2], JSON.stringify({ pid:process.pid, anchor })); setInterval(() => {}, 1000);`,
    );
    const quote = (value: string) => '"' + value.replaceAll('"', '\\"') + '"';
    const pending = git(
      ["-c", `alias.paws-pause=!${quote(process.execPath)} ${quote(script)}`, "paws-pause", marker],
      {
        signal: controller.signal,
        onCleanupFailure() {
          cleanupFailed = true;
        },
      },
    ).catch((error: unknown) => error);
    try {
      for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(5);
      expect(existsSync(marker)).toBe(true);
      const owner = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; anchor: number };
      pid = owner.pid;
      expect(owner.anchor).toBeGreaterThan(0);
      process.kill(owner.anchor, "SIGKILL");
      controller.abort();
      expect(await pending).toMatchObject({ message: "Git process cleanup could not be verified" });
      expect(cleanupFailed).toBe(true);
    } finally {
      controller.abort();
      await pending;
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);

test("remote task snapshots pin a historical commit under a clean Git environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-pinned-task-"));
  const source = join(root, "source");
  const workspace = join(root, "task");
  try {
    await git(["init", "-b", "main", source]);
    writeFileSync(join(source, "source.txt"), "authorized source");
    await git(["-C", source, "add", "."]);
    await git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Authorized",
    ]);
    const commit = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    writeFileSync(join(source, "source.txt"), "newer source");
    await git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-am",
      "Newer",
    ]);
    const input = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: source,
      workspace,
      commit,
      signal: new AbortController().signal,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      maxArchiveBytes: 536_870_912,
    };
    const snapshot = await prepareRepositorySnapshot(input);
    expect(snapshot.commit).toBe(commit);
    expect(readFileSync(join(snapshot.path, "source.txt"), "utf8")).toBe("authorized source");
    expect(existsSync(join(snapshot.path, ".git"))).toBe(false);
    await expect(prepareRepositorySnapshot({ ...input, commit: "a".repeat(40) })).rejects.toThrow(
      "ownership changed",
    );
    await expect(
      prepareRepositorySnapshot({ ...input, workspace: join(root, "bounded"), maxArchiveBytes: 1 }),
    ).rejects.toThrow("archive exceeds");
    expect(existsSync(join(root, "bounded", "repository"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
