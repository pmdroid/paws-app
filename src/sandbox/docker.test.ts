import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AUTH_MOUNT,
  CREDENTIAL_PROBE_SCRIPT,
  DEFAULT_SANDBOX_IMAGE,
  authVolumeName,
  buildCredentialProbe,
  buildDockerLogin,
  buildDockerRun,
  dockerClientEnv,
  loginDocker,
  readDockerRecords,
  writeRecordingDocker,
  type DockerRunSpec,
} from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const worktree = "/Users/dev/.paws/worktrees/ENG-1";
const proxyUrl = "http://127.0.0.1:9";

function dirtyEnv(): NodeJS.ProcessEnv {
  return {
    HOME: "/Users/dev",
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    SSH_AGENT_PID: "99",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-openai-secret",
    GITHUB_TOKEN: "ghp_secret",
    GH_TOKEN: "ghp_other",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
  };
}

function spec(overrides: Partial<DockerRunSpec> = {}): DockerRunSpec {
  return {
    agent: "claude",
    worktree,
    command: "claude-agent-acp",
    args: ["--verbose"],
    proxyUrl,
    hostEnv: dirtyEnv(),
    uid: 1000,
    gid: 1000,
    ...overrides,
  };
}

describe("docker run argv", () => {
  test("mounts only the worktree, drops host credentials, and sets network none plus the proxy", () => {
    const plan = buildDockerRun(spec());
    const mounts = mountSpecs(plan.args);
    expect(mounts.filter((mount) => mount.startsWith("type=bind,"))).toEqual([
      `type=bind,src=${worktree},dst=${worktree}`,
    ]);
    expect(mounts.filter((mount) => mount.startsWith("type=volume,"))).toEqual([
      `type=volume,src=paws-claude-auth,dst=${AUTH_MOUNT}`,
    ]);
    expect(plan.args).not.toContain("-v");
    expect(plan.args).not.toContain("--volume");
    expect(plan.args[plan.args.indexOf("--network") + 1]).toBe("none");
    expect(plan.args).toContain(`HTTPS_PROXY=${proxyUrl}`);
    expect(plan.args).toContain(`HTTP_PROXY=${proxyUrl}`);
    expect(plan.args).toContain(`HOME=${AUTH_MOUNT}`);
    expect(plan.args).toContain("--user");
    expect(plan.args).toContain("1000:1000");
    expect(plan.args.at(-2)).toBe("claude-agent-acp");
    expect(plan.args.at(-1)).toBe("--verbose");
    expect(plan.bin).toBe("docker");

    const flat = plan.args.join("\n");
    expect(flat).not.toContain("sk-ant-secret");
    expect(flat).not.toContain("sk-openai-secret");
    expect(flat).not.toContain("ghp_secret");
    expect(flat).not.toContain("ghp_other");
    expect(flat).not.toContain("aws-secret");
    expect(flat).not.toContain("/tmp/ssh-agent.sock");
    expect(flat).not.toContain("docker.sock");
    expect(flat).not.toContain("type=bind,src=/Users/dev,");
    expect(flat).not.toContain("HOME=/Users/dev");

    expect(plan.env.PATH).toBe("/usr/bin:/bin");
    expect(plan.env.LANG).toBe("C.UTF-8");
    expect(plan.env.HOME).toBeUndefined();
    expect(plan.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.env.OPENAI_API_KEY).toBeUndefined();
    expect(plan.env.GITHUB_TOKEN).toBeUndefined();
    expect(plan.env.GH_TOKEN).toBeUndefined();
    expect(plan.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  test("codex uses the codex login volume", () => {
    const plan = buildDockerRun(spec({ agent: "codex", command: "codex-acp", args: [] }));
    expect(authVolumeName("codex")).toBe("paws-codex-auth");
    expect(mountSpecs(plan.args)).toContain(`type=volume,src=paws-codex-auth,dst=${AUTH_MOUNT}`);
    expect(plan.args.at(-1)).toBe("codex-acp");
  });

  test("a fake docker binary records that argv", async () => {
    const root = await tempDir();
    const fake = await writeRecordingDocker(root);
    const plan = buildDockerRun(spec({ bin: fake.bin }));
    const proc = Bun.spawn([plan.bin, ...plan.args], {
      env: plan.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const [record] = await readDockerRecords(fake.record);
    expect(record?.argv).toEqual(plan.args);
    expect(record?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(record?.env.HOME).toBeUndefined();
    expect(record?.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(record?.env.PATH).toBe("/usr/bin:/bin");
  });

  test("refuses to mount the host home, ssh, or the docker socket", () => {
    const hostEnv = dirtyEnv();
    expect(() => buildDockerRun(spec({ worktree: "/Users/dev" }))).toThrow(/home/);
    expect(() => buildDockerRun(spec({ worktree: "/Users" }))).toThrow(/home/);
    expect(() => buildDockerRun(spec({ worktree: "relative/worktree" }))).toThrow(/absolute/);
    expect(() => buildDockerRun(spec({ worktree: "/var/run/docker.sock" }))).toThrow(
      /Docker socket/,
    );
    expect(() => buildDockerRun(spec({ worktree: "/Users/dev/.ssh" }))).toThrow(/credentials/);
    expect(() => buildDockerRun(spec({ worktree: "/tmp/ssh-agent.sock", hostEnv }))).toThrow(
      /SSH agent/,
    );
    expect(() => buildDockerRun(spec({ proxyUrl: "http://user:secret@127.0.0.1:9" }))).toThrow(
      /credentials/,
    );
    expect(() => buildDockerRun(spec({ image: "--privileged" }))).toThrow(/image/);
  });

  test("credential probe uses the same isolation and the probe script", () => {
    const plan = buildCredentialProbe(spec());
    expect(plan.args).toContain("sh");
    expect(plan.args).toContain(CREDENTIAL_PROBE_SCRIPT);
    expect(plan.args[plan.args.indexOf("--network") + 1]).toBe("none");
    expect(mountSpecs(plan.args).filter((mount) => mount.startsWith("type=bind,"))).toEqual([
      `type=bind,src=${worktree},dst=${worktree}`,
    ]);
    expect(CREDENTIAL_PROBE_SCRIPT).toContain("probe ok: no host credentials");
    expect(CREDENTIAL_PROBE_SCRIPT).toContain("SSH_AUTH_SOCK");
    expect(CREDENTIAL_PROBE_SCRIPT).toContain("docker.sock");
    expect(plan.args.join("\n")).not.toContain("sk-ant-secret");
    expect(plan.env.HOME).toBeUndefined();
  });
});

describe("loginDocker", () => {
  test("records a volume create and a login run with no host mounts", async () => {
    const root = await tempDir();
    const fake = await writeRecordingDocker(root);
    const result = await loginDocker("claude", {
      dockerBin: fake.bin,
      proxyUrl,
      hostEnv: dirtyEnv(),
      tty: false,
      stdio: "pipe",
    });
    expect(result.agent).toBe("claude");
    expect(result.volume).toBe("paws-claude-auth");
    const records = await readDockerRecords(fake.record);
    expect(records.map((record) => record.argv)).toEqual([
      ["volume", "create", "paws-claude-auth"],
      result.args,
    ]);
    const run = result.args;
    expect(run[run.indexOf("--network") + 1]).toBe("bridge");
    expect(mountSpecs(run).some((mount) => mount.startsWith("type=bind,"))).toBe(false);
    expect(mountSpecs(run)).toEqual([`type=volume,src=paws-claude-auth,dst=${AUTH_MOUNT}`]);
    expect(run).toContain(`HTTPS_PROXY=${proxyUrl}`);
    expect(run.join(" ")).toContain("exec claude auth login");
    expect(run).not.toContain("--tty");
    const flat = run.join("\n");
    expect(flat).not.toContain("/Users/dev");
    expect(flat).not.toContain("sk-ant-secret");
    expect(flat).not.toContain("/tmp/ssh-agent.sock");
    expect(flat).not.toContain("docker.sock");
    expect(records[0]?.env.GITHUB_TOKEN).toBeUndefined();
    expect(records[1]?.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(records[1]?.env.HOME).toBeUndefined();
  });

  test("codex login allocates a tty when asked and can start the allow-list proxy", async () => {
    const root = await tempDir();
    const fake = await writeRecordingDocker(root);
    const tty = buildDockerLogin({
      agent: "codex",
      proxyUrl,
      hostEnv: dirtyEnv(),
      tty: true,
    });
    expect(tty.runArgs).toContain("--tty");
    expect(tty.runArgs).toContain(DEFAULT_SANDBOX_IMAGE);
    expect(tty.runArgs.join(" ")).toContain("exec codex login");
    expect(tty.volume).toBe("paws-codex-auth");

    const result = await loginDocker("codex", {
      dockerBin: fake.bin,
      hostEnv: dirtyEnv(),
      tty: false,
      stdio: "pipe",
    });
    expect(result.volume).toBe("paws-codex-auth");
    expect(
      result.args.some((arg) => arg.startsWith("HTTPS_PROXY=http://host.docker.internal:")),
    ).toBe(true);
    expect(result.args.join("\n")).not.toContain("sk-ant-secret");
  });
});

function mountSpecs(args: string[]): string[] {
  const specs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mount") {
      const specAt = args[i + 1];
      if (specAt) specs.push(specAt);
    }
  }
  return specs;
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paws-sandbox-"));
  roots.push(root);
  return root;
}
