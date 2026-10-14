import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, snapshotImplementationSkills } from "../src/acp";
import { publishRunnerJob, readRunnerJobInputs, type RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

test("paired runner consumes snapshotted external skills without committing the bundle or resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-remote-skills-"));
  try {
    const source = join(root, "source");
    const home = join(root, "home");
    const pawsRoot = join(root, "paws");
    const workRoot = join(root, "work");
    const outputDirectory = join(root, "output");
    for (const path of [
      source,
      home,
      workRoot,
      outputDirectory,
      join(pawsRoot, "skills/check/scripts"),
    ])
      mkdirSync(path, { recursive: true });
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    await git(["init", "-b", "main", source]);
    writeFileSync(join(source, "original.txt"), "original");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "commit", "-m", "initial"], { env });
    const baseSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    const repositoryBundle = join(root, "source.bundle");
    await git(["-C", source, "bundle", "create", repositoryBundle, "--all"]);
    chmodSync(repositoryBundle, 0o600);
    writeFileSync(
      join(pawsRoot, "config.toml"),
      '[skills.projects."acme/repo"]\nroot = "skills"\n',
    );
    writeFileSync(join(pawsRoot, "skills/check/SKILL.md"), "External implementation skill");
    writeFileSync(
      join(pawsRoot, "skills/check/scripts/run.sh"),
      "printf 'remote skill ran' > result.txt\n",
    );
    const bundle = (await snapshotImplementationSkills({
      pawsRoot,
      worktree: source,
      repository: "acme/repo",
    }))!;
    rmSync(join(pawsRoot, "skills"), { recursive: true });
    const attachments = Array.from({ length: 20 }, (_, id) => Buffer.from(`attachment ${id}`));
    const job: RunnerJob = {
      executionId: "01J00000000000000000000001",
      command: {
        type: "run",
        id: "cmd",
        runnerId: "runner",
        workspaceId: "workspace",
        runId: "run",
        itemId: "item",
        generation: 1,
        issuedAt: 1,
        expiresAt: Date.now() + 60_000,
        profile: { agent: "claude", model: "fixture-model" },
        repository: {
          owner: "acme",
          repo: "repo",
          remoteUrl: "https://github.com/acme/repo.git",
          baseSha,
        },
        prompt: "Implement",
        skillsInputId: 20,
        checkpointBot: { appId: "99", login: "paws-test[bot]", id: 88 },
        inputFiles: [
          ...attachments.map((bytes, id) => ({
            id,
            path: `.paws-linear-inputs/file-${id}.txt`,
            mimeType: "text/plain",
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          })),
          {
            id: 20,
            path: "private-skills.json",
            mimeType: "application/vnd.paws.skills+json",
            sizeBytes: bundle.length,
            sha256: createHash("sha256").update(bundle).digest("hex"),
          },
        ],
      },
    };
    const spool = {
      root: join(root, "spool"),
      runnerUid: process.getuid!(),
      agentGid: process.getgid!(),
    };
    mkdirSync(spool.root, { mode: 0o750 });
    publishRunnerJob(spool, job, { repositoryBundle, inputFiles: [...attachments, bundle] });
    const trace = join(root, "trace.json");
    const adapter = join(root, "adapter.ts");
    const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
    writeFileSync(
      adapter,
      `import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(workRoot)};
const skills = join(root, readdirSync(root).find(name => name.startsWith(".paws-skills-"))!);
const script = ${JSON.stringify(join(root, "script.json"))};
writeFileSync(script, JSON.stringify({model:"fixture-model", steps:[{type:"terminal", command:"bash", args:[join(skills,"check/scripts/run.sh")]},{type:"end"}]}));
const child = Bun.spawn([process.execPath, ${JSON.stringify(fake)}, ${JSON.stringify(trace)}, script], {stdin:"inherit",stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`,
    );
    const result = await executeRunnerCommand({
      job,
      repositoryBundle,
      inputs: readRunnerJobInputs(spool, job.executionId),
      outputDirectory,
      workRoot,
      home,
      resultsGid: process.getgid!(),
      launch: { command: process.execPath, args: [adapter] },
    });
    expect(result.run.stopReason).toBe("end_turn");
    expect(result.candidateSha).not.toBe(baseSha);
    const checkout = join(workRoot, job.executionId);
    expect((await git(["-C", checkout, "diff", "HEAD~1", "HEAD", "--name-only"])).trim()).toBe(
      "result.txt",
    );
    expect(readFileSync(join(checkout, "result.txt"), "utf8")).toBe("remote skill ran");
    expect(existsSync(join(checkout, "private-skills.json"))).toBe(false);
    expect(readdirSync(workRoot).some((name) => name.startsWith(".paws-skills-"))).toBe(false);
    const prompts = JSON.stringify(JSON.parse(readFileSync(trace, "utf8")).prompts);
    expect(prompts).toContain("External implementation skill");
    expect(prompts).not.toContain(join(pawsRoot, "skills"));
    expect(prompts).not.toContain("Input file: ./private-skills.json");
    expect(await git(["-C", source, "status", "--porcelain"])).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
