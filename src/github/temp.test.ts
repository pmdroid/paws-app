import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitEnv, withCredential } from "./git";
import { publicationExec } from "./publication";
import { useGitTempDirectory } from "./temp";
import type { GitExec } from "./types";

const REMOTE = "https://github.com/acme/widgets.git";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paws-tmp-test-"));
  useGitTempDirectory(root);
});

afterEach(async () => {
  useGitTempDirectory(null);
  await rm(root, { recursive: true, force: true });
});

const ok: GitExec = async () => ({ stdout: "", stderr: "" });

for (const outcome of ["succeeds", "fails"]) {
  test(`withCredential uses the Paws tmp directory and removes it when the call ${outcome}`, async () => {
    let dir = "";
    const call = withCredential("acme-token", ok, async ({ argsPrefix }) => {
      dir = path.dirname(argsPrefix.at(-1)!.replace("credential.helper=", ""));
      expect(await readdir(root)).toEqual([path.basename(dir)]);
      if (outcome === "fails") throw new Error("acme failure");
      return "done";
    });
    if (outcome === "fails") await expect(call).rejects.toThrow("acme failure");
    else expect(await call).toBe("done");
    expect(path.dirname(dir)).toBe(root);
    expect(path.basename(dir)).toStartWith("paws-git-");
    expect(await readdir(root)).toEqual([]);
  });

  test(`publicationExec uses the Paws tmp directory and removes it when git ${outcome}`, async () => {
    const dirs: string[] = [];
    const gitExec: GitExec = async (args, options) => {
      dirs.push(options.cwd);
      if (args.includes("ls-remote") && outcome === "fails") throw new Error("acme failure");
      return { stdout: "", stderr: "" };
    };
    const call = publicationExec(
      gitExec,
      undefined,
      null,
    )(["ls-remote", REMOTE], {
      cwd: root,
      env: gitEnv("acme-token"),
    });
    if (outcome === "fails") await expect(call).rejects.toThrow("acme failure");
    else await call;
    const dir = dirs.at(-1)!;
    expect(path.dirname(dir)).toBe(root);
    expect(path.basename(dir)).toStartWith("paws-publication-");
    expect(await readdir(root)).toEqual([]);
  });
}
