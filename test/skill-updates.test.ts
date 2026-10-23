import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillPin } from "../src/db";
import { createSkillUpdates, gitRemoteCommit } from "../src/skills";

const pinned = "a".repeat(40);
const moved = "b".repeat(40);

function gitSkill(name: string, ref?: string, version = pinned): SkillPin {
  return {
    name,
    source: { kind: "git", url: `https://github.com/pmdroid/${name}.git`, ...(ref ? { ref } : {}) },
    version,
    sha256: "c".repeat(64),
    sizeBytes: 1,
    agents: ["claude"],
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
}

function remote(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  return {
    calls,
    async latest(url: string, ref: string | undefined) {
      const key = `${url}#${ref ?? "HEAD"}`;
      calls.push(key);
      const answer = answers[key];
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error("unknown");
      return answer;
    },
  };
}

describe("skill update check", () => {
  test("a ref that moved offers the new commit", async () => {
    const git = remote({ "https://github.com/pmdroid/review.git#main": moved });
    const updates = createSkillUpdates({ latest: git.latest });
    const skills = [gitSkill("review", "main")];
    await updates.check(skills);
    expect(updates.available(skills)).toEqual({ review: moved });
  });

  test("an unchanged ref offers nothing", async () => {
    const git = remote({ "https://github.com/pmdroid/review.git#HEAD": pinned });
    const updates = createSkillUpdates({ latest: git.latest });
    const skills = [gitSkill("review")];
    await updates.check(skills);
    expect(updates.available(skills)).toEqual({});
  });

  test("a skill pinned to a commit is never checked", async () => {
    const git = remote({});
    const updates = createSkillUpdates({ latest: git.latest });
    const skills = [gitSkill("review", moved.toUpperCase())];
    await updates.check(skills);
    expect(git.calls).toEqual([]);
    expect(updates.available(skills)).toEqual({});
  });

  test("a failed check shows nothing and is tried again next time", async () => {
    const answers: Record<string, string | Error> = {
      "https://github.com/pmdroid/review.git#main": moved,
    };
    const git = remote(answers);
    const updates = createSkillUpdates({ latest: git.latest });
    const skills = [gitSkill("review", "main")];
    await updates.check(skills);
    answers["https://github.com/pmdroid/review.git#main"] = new Error("offline");
    await updates.check(skills);
    expect(updates.available(skills)).toEqual({});
    answers["https://github.com/pmdroid/review.git#main"] = moved;
    await updates.check(skills);
    expect(updates.available(skills)).toEqual({ review: moved });
    expect(git.calls).toHaveLength(3);
  });

  test("skills that share a source and ref are checked once", async () => {
    const git = remote({ "https://github.com/pmdroid/review.git#main": moved });
    const updates = createSkillUpdates({ latest: git.latest });
    const first = gitSkill("review", "main");
    const second = { ...first, name: "review-copy", version: moved };
    const npm: SkillPin = { ...first, name: "npm", source: { kind: "npm", package: "npm" } };
    await updates.check([first, second, npm]);
    expect(git.calls).toEqual(["https://github.com/pmdroid/review.git#main"]);
    expect(updates.available([first, second, npm])).toEqual({ review: moved });
  });

  test("the remote commit comes from git ls-remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-skill-updates-"));
    try {
      const run = (...args: string[]) => {
        const result = Bun.spawnSync(
          ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
          { cwd: root, stdout: "pipe", stderr: "pipe" },
        );
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString().trim();
      };
      run("init", "--quiet", "--initial-branch=main");
      writeFileSync(join(root, "SKILL.md"), "---\nname: review\n---\n");
      run("add", ".");
      run("commit", "--quiet", "-m", "Add review");
      run("tag", "-a", "v1", "-m", "v1");
      const first = run("rev-parse", "HEAD");
      writeFileSync(join(root, "SKILL.md"), "---\nname: review\n---\nv2\n");
      run("commit", "--quiet", "-am", "Change review");
      const second = run("rev-parse", "HEAD");
      expect(await gitRemoteCommit(root, "main")).toBe(second);
      expect(await gitRemoteCommit(root, undefined)).toBe(second);
      expect(await gitRemoteCommit(root, "v1")).toBe(first);
      expect(gitRemoteCommit(root, "missing")).rejects.toThrow("has no missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
