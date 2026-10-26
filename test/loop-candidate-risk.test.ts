import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyCandidateRisk } from "../src/loop";
import { tempHome } from "./helpers";

function repo() {
  const dir = tempHome();
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  run("init", "-q", "-b", "main");
  run("config", "user.email", "paws-test@example.com");
  run("config", "user.name", "Paws Test");
  run("config", "commit.gpgsign", "false");
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = () => {
    run("add", "-A");
    run("commit", "-q", "--allow-empty", "-m", "change");
    return run("rev-parse", "HEAD").trim();
  };
  const git = async (args: string[]) => run(...args);
  return { dir, write, commit, git };
}

describe("classifyCandidateRisk", () => {
  test("a candidate that changes no high-risk path is normal", async () => {
    const { write, commit, git } = repo();
    write("src/auth/session.ts", "a\n");
    const base = commit();
    write("docs/readme.md", "b\n");
    const head = commit();
    expect(
      await classifyCandidateRisk({ git, base, head, settingsGlobs: ["src/auth/**"] }),
    ).toEqual({ tier: "normal", paths: [] });
  });

  test("settings globs and the base commit's file both add high-risk paths", async () => {
    const { write, commit, git } = repo();
    write(".paws/high-risk-paths", "# reviewed by a person\ninfra/**\n");
    const base = commit();
    write("src/auth/session.ts", "a\n");
    write("infra/main.tf", "b\n");
    write("src/loop/brief.ts", "c\n");
    const head = commit();
    expect(
      await classifyCandidateRisk({ git, base, head, settingsGlobs: ["src/auth/**"] }),
    ).toEqual({ tier: "high", paths: ["infra/main.tf", "src/auth/session.ts"] });
  });

  test("a candidate cannot remove its own paths from the file", async () => {
    const { dir, write, commit, git } = repo();
    write(".paws/high-risk-paths", "infra/**\n");
    const base = commit();
    rmSync(join(dir, ".paws/high-risk-paths"));
    write("infra/main.tf", "b\n");
    const head = commit();
    expect(await classifyCandidateRisk({ git, base, head, settingsGlobs: [] })).toEqual({
      tier: "high",
      paths: ["infra/main.tf"],
    });
  });

  test("a path added by the candidate's own file does not count", async () => {
    const { write, commit, git } = repo();
    const base = commit();
    write(".paws/high-risk-paths", "docs/**\n");
    write("docs/a.md", "a\n");
    const head = commit();
    expect((await classifyCandidateRisk({ git, base, head, settingsGlobs: [] })).tier).toBe(
      "normal",
    );
  });

  test("moving a file out of a high-risk directory is high", async () => {
    const { dir, write, commit, git } = repo();
    write("src/auth/session.ts", "export const session = 1;\n");
    const base = commit();
    mkdirSync(join(dir, "src/other"), { recursive: true });
    renameSync(join(dir, "src/auth/session.ts"), join(dir, "src/other/session.ts"));
    const head = commit();
    expect(
      (await classifyCandidateRisk({ git, base, head, settingsGlobs: ["src/auth/**"] })).paths,
    ).toEqual(["src/auth/session.ts"]);
  });
});
