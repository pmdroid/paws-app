import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultGitExec, gitEnv } from "./git";
import { publicationExec } from "./publication";
import type { GitExec } from "./types";

const exec = promisify(execFile);
const roots: string[] = [];
const token = "synthetic-acme-publication-canary";
const WIDGETS = "https://github.com/acme/widgets.git";
const GADGETS = "https://github.com/acme/gadgets.git";
const PREFIX = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper="];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paws-publication-repository-"));
  roots.push(root);
  const store = path.join(root, "publication");
  const worktree = path.join(root, "candidate");
  const remotes: Record<string, string> = {
    [WIDGETS]: path.join(root, "widgets.git"),
    [GADGETS]: path.join(root, "gadgets.git"),
  };
  for (const remote of Object.values(remotes))
    await exec("git", ["init", "--bare", "--initial-branch=main", remote]);
  await exec("git", ["init", "--initial-branch=main", worktree]);
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: worktree })).stdout.trim();
  const commit = async (text: string) => {
    await writeFile(path.join(worktree, "file"), `${text}\n`);
    await git("add", ".");
    await git("commit", "-m", text);
    return git("rev-parse", "HEAD");
  };
  await commit("base");
  await git("push", remotes[WIDGETS]!, "main");
  await git("push", remotes[GADGETS]!, "main");
  const calls: { args: string[]; cwd: string; credentialed: boolean }[] = [];
  const real = defaultGitExec();
  const fake: GitExec = async (args, options) => {
    const credentialed = options.env.PAWS_GITHUB_TOKEN !== undefined;
    calls.push({ args, cwd: options.cwd, credentialed });
    if (credentialed) {
      const gitDir = args[args.indexOf("--git-dir") + 1];
      expect(args).toContain("--git-dir");
      expect(gitDir).not.toBe(worktree);
      expect(gitDir).not.toBe(path.join(worktree, ".git"));
      expect(options.cwd).not.toBe(worktree);
    } else expect(JSON.stringify(options.env)).not.toContain(token);
    const local = args.map((arg) => remotes[arg] ?? arg);
    return real(local, options);
  };
  const publication = publicationExec(fake, undefined, store);
  const push = (branch: string, remote = WIDGETS) =>
    publication([...PREFIX, "push", remote, `HEAD:refs/heads/${branch}`], {
      cwd: worktree,
      env: gitEnv(token),
    });
  const fetchMain = (remote = WIDGETS) =>
    publication([...PREFIX, "fetch", remote, "+refs/heads/main:refs/paws/upstream-main"], {
      cwd: worktree,
      env: gitEnv(token),
    });
  const persistent = path.join(store, "acme", "widgets.git");
  return { root, store, worktree, remotes, git, commit, calls, fake, push, fetchMain, persistent };
}

function bundleCreates(calls: { args: string[] }[]) {
  return calls.filter((call) => call.args[0] === "bundle" && call.args[1] === "create");
}

async function tokenAppearsUnder(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if ((await readFile(file)).includes(token)) return true;
  }
  return false;
}

test("a second push bundles only the commit the publication repository lacks", async () => {
  const f = await fixture();
  const first = await f.commit("first");
  await f.push("paws/acme-1");
  expect(bundleCreates(f.calls)[0]!.args.filter((arg) => arg.startsWith("^"))).toEqual([]);
  expect((await stat(f.persistent)).mode & 0o777).toBe(0o700);
  f.calls.length = 0;
  const second = await f.commit("second");
  await f.push("paws/acme-1");
  const [created] = bundleCreates(f.calls);
  expect(created!.args).toContain(`^${first}`);
  const bundle = created!.args[2]!;
  expect(f.calls.some((call) => call.args.includes("unbundle"))).toBe(false);
  expect(f.calls.map((call) => call.args.join(" "))).toContain(
    `--git-dir ${f.persistent} -c gc.autoDetach=false gc --auto --quiet`,
  );
  expect(bundle.startsWith(f.persistent)).toBe(false);
  const remote = f.remotes[WIDGETS]!;
  expect(
    (await exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/paws/acme-1"])).stdout.trim(),
  ).toBe(second);
  expect(await tokenAppearsUnder(f.store)).toBe(false);
});

test("a push with nothing new stages no bundle and still pushes HEAD", async () => {
  const f = await fixture();
  const head = await f.commit("first");
  await f.push("paws/acme-1");
  await f.push("paws/acme-2");
  const remote = f.remotes[WIDGETS]!;
  expect(
    (await exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/paws/acme-2"])).stdout.trim(),
  ).toBe(head);
});

test("a fetch runs in the publication repository and reuses the objects it has", async () => {
  const f = await fixture();
  const base = await f.git("rev-parse", "HEAD");
  await f.fetchMain();
  expect(await f.git("rev-parse", "refs/paws/upstream-main")).toBe(base);
  const upstream = path.join(f.root, "upstream");
  await exec("git", ["clone", f.remotes[WIDGETS]!, upstream]);
  await writeFile(path.join(upstream, "other"), "advance\n");
  await exec("git", ["add", "."], { cwd: upstream });
  await exec("git", ["commit", "-m", "advance main"], { cwd: upstream });
  await exec("git", ["push", "origin", "main"], { cwd: upstream });
  const advanced = (await exec("git", ["rev-parse", "HEAD"], { cwd: upstream })).stdout.trim();
  f.calls.length = 0;
  await f.fetchMain();
  const network = f.calls.find((call) => call.credentialed)!;
  expect(network.args.slice(0, 2)).toEqual(["--git-dir", f.persistent]);
  expect(network.args).toContain("--prune");
  expect(f.calls.some((call) => call.args[0] === "init")).toBe(false);
  await exec("git", ["--git-dir", f.persistent, "cat-file", "-e", `${base}^{commit}`]);
  expect(await f.git("rev-parse", "refs/paws/upstream-main")).toBe(advanced);
});

test("calls for one repository run one after the other, other repositories in parallel", async () => {
  const f = await fixture();
  const gates: (() => void)[] = [];
  const order: string[] = [];
  const gated: GitExec = async (args, options) => {
    if (options.env.PAWS_GITHUB_TOKEN !== undefined) {
      const name = args.find((arg) => arg.startsWith("https://"))!;
      order.push(`start ${name}`);
      await new Promise<void>((resolve) => gates.push(resolve));
      order.push(`end ${name}`);
    }
    return f.fake(args, options);
  };
  const run = publicationExec(gated, undefined, f.store);
  const fetch = (remote: string) =>
    run([...PREFIX, "fetch", remote, "+refs/heads/main:refs/paws/upstream-main"], {
      cwd: f.worktree,
      env: gitEnv(token),
    });
  const calls = [fetch(WIDGETS), fetch(WIDGETS), fetch(GADGETS)];
  const until = async (count: number) => {
    for (let i = 0; i < 200 && gates.length < count; i++) await Bun.sleep(10);
  };
  await until(2);
  await Bun.sleep(100);
  expect([...order].sort()).toEqual([`start ${GADGETS}`, `start ${WIDGETS}`]);
  gates.splice(0).forEach((open) => open());
  await until(1);
  expect(order.filter((entry) => entry === `start ${WIDGETS}`)).toHaveLength(2);
  gates.splice(0).forEach((open) => open());
  await Promise.all(calls);
  expect(order.indexOf(`start ${WIDGETS}`, order.indexOf(`end ${WIDGETS}`))).toBeGreaterThan(
    order.indexOf(`end ${WIDGETS}`),
  );
});

test("a call aborted while it waits for the repository stops without running", async () => {
  const f = await fixture();
  let open: () => void = () => undefined;
  let started: () => void = () => undefined;
  const holding = new Promise<void>((resolve) => (started = resolve));
  let network = 0;
  const gated: GitExec = async (args, options) => {
    if (options.env.PAWS_GITHUB_TOKEN !== undefined && network++ === 0) {
      started();
      await new Promise<void>((resolve) => (open = resolve));
    }
    return f.fake(args, options);
  };
  const run = publicationExec(gated, undefined, f.store);
  const fetch = (signal?: AbortSignal) =>
    run([...PREFIX, "fetch", WIDGETS, "+refs/heads/main:refs/paws/upstream-main"], {
      cwd: f.worktree,
      env: gitEnv(token),
      signal,
    });
  const first = fetch();
  await holding;
  const controller = new AbortController();
  const waiting = fetch(controller.signal);
  const third = fetch();
  controller.abort(new Error("acme stop"));
  await expect(waiting).rejects.toThrow("acme stop");
  expect(network).toBe(1);
  open();
  await Promise.all([first, third]);
  expect(network).toBe(2);
});

for (const damage of ["missing", "corrupt", "missing objects", "stale lock"] as const) {
  test(`a ${damage} publication repository is rebuilt and the push starts from empty`, async () => {
    const f = await fixture();
    await f.commit("first");
    await f.push("paws/acme-1");
    const marker = path.join(f.persistent, "marker");
    await writeFile(marker, "");
    if (damage === "missing") await rm(f.persistent, { recursive: true });
    if (damage === "corrupt") await writeFile(path.join(f.persistent, "HEAD"), "garbage\n");
    if (damage === "missing objects") {
      await rm(path.join(f.persistent, "objects"), { recursive: true });
      await exec("git", ["init", "--bare", "--template=", path.join(f.root, "empty.git")]);
      await exec("cp", ["-r", path.join(f.root, "empty.git", "objects"), f.persistent]);
    }
    if (damage === "stale lock") {
      const child = Bun.spawn(["true"]);
      await child.exited;
      await writeFile(`${f.persistent}.lock`, String(child.pid));
    }
    f.calls.length = 0;
    const second = await f.commit("second");
    await f.push("paws/acme-1");
    const created = bundleCreates(f.calls);
    expect(created.at(-1)!.args.filter((arg) => arg.startsWith("^"))).toEqual([]);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(`${f.persistent}.lock`).exists()).toBe(false);
    await exec("git", ["--git-dir", f.persistent, "cat-file", "-e", `${second}^{commit}`]);
    const remote = f.remotes[WIDGETS]!;
    expect(
      (
        await exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/paws/acme-1"])
      ).stdout.trim(),
    ).toBe(second);
  });
}

test("a remote that is not an HTTPS GitHub repository keeps the empty temporary repository", async () => {
  const f = await fixture();
  await f.commit("first");
  const run = publicationExec(f.fake, undefined, f.store);
  await run([...PREFIX, "push", f.remotes[WIDGETS]!, "HEAD:refs/heads/paws/acme-1"], {
    cwd: f.worktree,
    env: gitEnv(),
  });
  expect(await Bun.file(path.join(f.store, "acme")).exists()).toBe(false);
  expect(f.calls.find((call) => call.args[0] === "init")!.args.at(-1)).toContain(
    "paws-publication-",
  );
});
