import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decidePermission, type GuardContext } from "./permissions";

const home = "/home/dev";
const pawsRoot = "/home/dev/.paws";
const worktree = "/home/dev/.paws/worktrees/ENG-1";
const ctx: GuardContext = { home, worktree, pawsRoot };

describe("permission guard", () => {
  test("allows edits and commands inside the worktree", () => {
    expect(
      decidePermission({ kind: "edit", locations: [{ path: `${worktree}/src/main.ts` }] }, ctx)
        .allow,
    ).toBe(true);
    expect(decidePermission({ kind: "execute", rawInput: { command: "bun test" } }, ctx)).toEqual({
      allow: true,
      reason: "inside the worktree",
    });
    expect(
      decidePermission({ kind: "execute", rawInput: { command: "git status" } }, ctx).allow,
    ).toBe(true);
    expect(decidePermission({ kind: "execute", title: "npm install" }, ctx).allow).toBe(true);
  });

  test("denies the Paws home, ssh, gh config, keychains, git push, and gh", () => {
    const denied = [
      { kind: "read", locations: [{ path: `${pawsRoot}/paws.db` }] },
      { kind: "read", locations: [{ path: `${pawsRoot}/secrets/linear.token` }] },
      { kind: "read", locations: [{ path: `${home}/.ssh/id_rsa` }] },
      { kind: "read", locations: [{ path: "~/.ssh/id_rsa" }] },
      { kind: "read", locations: [{ path: `${home}/.config/gh/hosts.yml` }] },
      { kind: "read", locations: [{ path: `${home}/Library/Keychains/login.keychain-db` }] },
      { kind: "read", locations: [{ path: "/Library/Keychains/System.keychain" }] },
      { kind: "execute", rawInput: { command: "git push origin HEAD" } },
      { kind: "execute", rawInput: { command: `git -C ${worktree} push` } },
      { kind: "execute", rawInput: { command: "gh pr create" } },
      { kind: "execute", rawInput: { command: "bash -lc 'git push'" } },
      { kind: "execute", rawInput: { command: `cat ${home}/.ssh/id_rsa` } },
      { kind: "execute", rawInput: { command: "curl https://example.com" } },
      { kind: "fetch", title: "download" },
    ];
    for (const subject of denied) {
      const decision = decidePermission(subject, ctx);
      expect(decision.allow, JSON.stringify(subject)).toBe(false);
    }
  });

  test("denies a relative path that resolves outside the worktree", () => {
    const decision = decidePermission(
      { kind: "read", locations: [{ path: "../../paws.db" }] },
      ctx,
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("Paws home");
  });

  test("denies a symlink that leaves the worktree", async () => {
    const root = await mkdirTemp();
    const tree = join(root, "work");
    const outside = join(root, "secret");
    await mkdir(tree, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "key"), "secret");
    await symlink(outside, join(tree, "leak"));
    const decision = decidePermission(
      { kind: "read", locations: [{ path: join(tree, "leak", "key") }] },
      { home: root, worktree: tree, pawsRoot: join(root, ".paws") },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("symlink");
  });
});

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "paws-guard-"));
}
