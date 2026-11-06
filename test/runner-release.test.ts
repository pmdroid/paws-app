import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/runner-release.yml", import.meta.url), "utf8"),
);

test("runner package builds run only for published releases, and publication waits for both architectures", () => {
  expect(workflow.on).toEqual({ release: { types: ["published"] } });
  expect(workflow.jobs.build.strategy.matrix.include).toEqual([
    { architecture: "amd64", platform: "linux-x64", runner: "ubuntu-24.04" },
    { architecture: "arm64", platform: "linux-arm64", runner: "ubuntu-24.04-arm" },
  ]);
  expect(workflow.jobs.publish.needs).toBe("build");
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.publish.permissions).toEqual({ contents: "write" });
});

test("the actual release-version step accepts numeric release tags and rejects executable or unsupported input", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-release-tags-"));
  const step = workflow.jobs.build.steps.find(
    (value: { name?: string }) => value.name === "Validate release version",
  );
  try {
    for (const [index, tag] of [
      "v1.2.3",
      "2.0.0",
      "v1.2.3-rc.1",
      "v01.2.3",
      "v1.2.3\nOTHER=value",
      `v1.2.3$(touch ${join(root, "injected")})`,
    ].entries()) {
      const output = join(root, `${index}.env`);
      const command = Bun.spawn(["/bin/bash", "-e", "-o", "pipefail", "-c", step.run], {
        env: { PATH: "/usr/bin:/bin", RELEASE_TAG: tag, GITHUB_ENV: output },
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await command.exited;
      if (index < 2) {
        expect(code).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(`RUNNER_VERSION=${tag.replace(/^v/, "")}\n`);
      } else {
        expect(code).not.toBe(0);
        expect(Bun.file(output).size).toBe(0);
      }
    }
    expect(await Bun.file(join(root, "injected")).exists()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner package pins mise for both architectures and a wrong checksum fails the build", async () => {
  const release = new URL("../deploy/linux/release.py", import.meta.url).pathname;
  const script = `
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location("release", sys.argv[1])
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
class Response(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *_): return False
requested = []
def opener(url, timeout):
    requested.append(url)
    return Response(b"tampered mise")
rejected = {}
for name in ("linux-x64", "linux-arm64"):
    try:
        release.download_mise(name, opener)
        rejected[name] = None
    except ValueError as error:
        rejected[name] = str(error)
print(json.dumps({"version": release.MISE_VERSION, "digests": release.MISE_SHA256, "required": "bin/mise" in release.REQUIRED, "requested": requested, "rejected": rejected}))
`;
  const child = Bun.spawn(["python3", "-I", "-B", "-c", script, release], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.version).toMatch(/^\d{4}\.\d{1,2}\.\d{1,4}$/);
  expect(Object.keys(result.digests).sort()).toEqual(["linux-arm64", "linux-x64"]);
  for (const digest of Object.values(result.digests)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(result.required).toBe(true);
  expect(result.requested).toEqual(
    ["linux-x64", "linux-arm64"].map(
      (name) =>
        `https://github.com/jdx/mise/releases/download/v${result.version}/mise-v${result.version}-${name}`,
    ),
  );
  expect(result.rejected).toEqual({
    "linux-x64": `mise ${result.version} linux-x64 checksum mismatch`,
    "linux-arm64": `mise ${result.version} linux-arm64 checksum mismatch`,
  });
});

test("the runner package pins gh for both architectures, refuses a wrong checksum and keeps only bin/gh", async () => {
  const release = new URL("../deploy/linux/release.py", import.meta.url).pathname;
  const script = `
import hashlib, importlib.util, io, json, sys, tarfile
spec = importlib.util.spec_from_file_location("release", sys.argv[1])
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
class Response(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *_): return False
def tarball(name):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for path, content in ((f"gh_{release.GH_VERSION}_{name}/bin/gh", b"\\x7fELFfake gh"), (f"gh_{release.GH_VERSION}_{name}/LICENSE", b"license")):
            member = tarfile.TarInfo(path)
            member.size = len(content)
            member.mode = 0o755
            archive.addfile(member, io.BytesIO(content))
    return stream.getvalue()
pinned = dict(release.GH_SHA256)
requested = []
results = {}
for platform_name, name in release.GH_PLATFORM.items():
    content = tarball(name)
    def opener(url, timeout):
        requested.append(url)
        return Response(content)
    try:
        release.download_gh(platform_name, opener)
        results[platform_name] = {"wrong": None}
    except ValueError as error:
        results[platform_name] = {"wrong": str(error)}
    # The same fake bytes, pinned: they pass, and only bin/gh comes back.
    release.GH_SHA256[name] = hashlib.sha256(content).hexdigest()
    results[platform_name]["right"] = release.download_gh(platform_name, opener).decode()
    release.GH_SHA256[name] = pinned[name]
print(json.dumps({"version": release.GH_VERSION, "digests": pinned, "required": "agent-bin/gh" in release.REQUIRED, "requested": requested, "results": results}))
`;
  const child = Bun.spawn(["python3", "-I", "-B", "-c", script, release], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(Object.keys(result.digests).sort()).toEqual(["linux_amd64", "linux_arm64"]);
  for (const digest of Object.values(result.digests)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(result.required).toBe(true);
  const url = (name: string) =>
    `https://github.com/cli/cli/releases/download/v${result.version}/gh_${result.version}_${name}.tar.gz`;
  expect(result.requested).toEqual([
    url("linux_amd64"),
    url("linux_amd64"),
    url("linux_arm64"),
    url("linux_arm64"),
  ]);
  expect(result.results).toEqual({
    "linux-x64": {
      wrong: `gh ${result.version} linux_amd64 checksum mismatch`,
      right: "\x7fELFfake gh",
    },
    "linux-arm64": {
      wrong: `gh ${result.version} linux_arm64 checksum mismatch`,
      right: "\x7fELFfake gh",
    },
  });
});

test("a packed runner artifact has no coding agent, musl package, devDependency or dashboard, and keeps every required file", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-pack-"));
  const deploy = new URL("../deploy/linux/", import.meta.url).pathname;
  const script = `
import argparse, importlib.util, json, pathlib, platform, sys, tarfile
from types import SimpleNamespace
from unittest import mock
spec = importlib.util.spec_from_file_location("packager", sys.argv[1] + "package.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
release = packager.release
root = pathlib.Path(sys.argv[2])
source = root / "source"
modules = root / "production" / "node_modules"
def write(path, content=b"synthetic"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
for name in release.REQUIRED:
    write(source / name.removeprefix("app/"))
write(source / "deploy/linux/agents.json", open(sys.argv[1] + "agents.json", "rb").read())
root_manifest = json.load(open(sys.argv[3]))
development = root_manifest["devDependencies"]
agents = {package: root_manifest["dependencies"][package] for package in release.AGENT_PACKAGES.values()}
write(source / "package.json", json.dumps({"dependencies": {"left-pad": "1", "shared": "1", **agents}, "devDependencies": development}).encode())
# Agent packages and what only they need stay out; a dependency the runner also needs stays in.
for package in agents:
    write(modules / package / "package.json", json.dumps({"dependencies": {"agent-only": "1", "shared": "1"}}).encode())
    write(modules / package / "dist/index.js")
write(modules / "agent-only/index.js")
write(modules / "shared/index.js")
write(modules / ".bin/claude-agent-acp", b"#!/bin/sh\\n")
arch = release.ARCHITECTURE[0]
for name in development:
    write(modules / name / "package.json", b"{}")
for name in (f"@anthropic-ai/claude-agent-sdk-linux-{arch}-musl", f"@oxlint/binding-linux-{arch}-musl", f"lightningcss-linux-{arch}-musl", "left-pad/node_modules/helper-linux-musl"):
    write(modules / name / "index.js")
write(modules / "left-pad/index.js")
for name in ("src/dashboard/index.ts", "src/dashboard/src/client/main.ts", "src/dashboard/dist/index.html", "src/dashboards/keep.ts"):
    write(source / name)
write(root / "bun")
installs = []
downloads = []
def install(bun, checkout, workspace):
    installs.append(str(checkout))
    return modules
with mock.patch.object(packager.subprocess, "run", return_value=SimpleNamespace(stdout=b"1.4.2\\n")), mock.patch.object(packager, "install_production", side_effect=install), mock.patch.object(release, "download_mise", return_value=b"\\x7fELFmise"), mock.patch.object(release, "download_gh", side_effect=lambda name: downloads.append(name) or b"\\x7fELFgh"):
    packager.pack(argparse.Namespace(source=source, bun=root / "bun", version="1.2.3", platform={"x86_64": "linux-x64", "aarch64": "linux-arm64"}[platform.machine()], output=root / "package", mise=None, gh=None))
archive = tarfile.open(root / "package" / "artifact.tar")
members = sorted(archive.getnames())
gh = archive.getmember("agent-bin/gh")
print(json.dumps({"gh": {"mode": gh.mode, "uid": gh.uid, "content": archive.extractfile(gh).read().decode(), "downloads": downloads}, "members": members, "required": sorted(release.REQUIRED), "development": sorted(development), "agents": sorted(agents), "installs": installs, "source": str(source.resolve())}))
`;
  try {
    const child = Bun.spawn(
      [
        "python3",
        "-I",
        "-B",
        "-c",
        script,
        deploy,
        root,
        new URL("../package.json", import.meta.url).pathname,
      ],
      { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result: {
      gh: { mode: number; uid: number; content: string; downloads: string[] };
      members: string[];
      required: string[];
      development: string[];
      agents: string[];
      installs: string[];
      source: string;
    } = JSON.parse(stdout);
    expect(result.installs).toEqual([result.source]);
    expect(result.members.filter((name) => name.startsWith("agent-bin/"))).toEqual([
      "agent-bin/gh",
    ]);
    expect(result.gh).toEqual({
      mode: 0o755,
      uid: 0,
      content: "\x7fELFgh",
      downloads: [process.arch === "arm64" ? "linux-arm64" : "linux-x64"],
    });
    expect(result.development).toContain("typescript");
    for (const name of result.required) expect(result.members).toContain(name);
    expect(result.members).toContain("app/node_modules/left-pad/index.js");
    expect(result.members).toContain("app/node_modules/shared/index.js");
    expect(result.members).toContain("deploy/linux/agents.json");
    expect(result.agents).toHaveLength(4);
    for (const name of [...result.agents, "agent-only", ".bin/claude-agent-acp"])
      expect(
        result.members.filter(
          (member) =>
            member.startsWith(`app/node_modules/${name}/`) || member === `app/node_modules/${name}`,
        ),
      ).toEqual([]);
    expect(result.members.filter((name) => name.startsWith("app/src/dashboard/"))).toEqual([]);
    expect(result.members).toContain("app/src/dashboards/keep.ts");
    const dashboard = ["@base-ui/react", "lucide-react", "react", "react-dom", "video.js"];
    for (const name of dashboard) expect(result.development).toContain(name);
    const packages = result.members
      .filter((name) => name.startsWith("app/node_modules/"))
      .flatMap((name) =>
        [...name.matchAll(/(?:^app\/|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)].map(
          (match) => match[1]!,
        ),
      );
    expect(packages.filter((name) => name.endsWith("-musl"))).toEqual([]);
    expect(packages.filter((name) => result.development.includes(name))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the release fails before building when a minimum runner version is above the tag, and names it", async () => {
  const steps: { name?: string; run?: string }[] = workflow.jobs.build.steps;
  const check = steps.findIndex((value) => value.name === "Check minimum runner versions");
  expect(check).toBeGreaterThan(
    steps.findIndex((value) => value.name === "Validate release version"),
  );
  expect(check).toBeLessThan(steps.findIndex((value) => value.name === "Build runner archive"));
  const constants = Object.entries(await import("../src/runner-protocol/versions"));
  const highest = constants
    .map(([, version]) => [...version])
    .sort((left, right) => left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!)
    .at(-1)!;
  const below = [...highest.slice(0, 2), highest[2]! - 1].join(".");
  const run = async (version: string) => {
    const child = Bun.spawn(["/bin/bash", "-e", "-o", "pipefail", "-c", steps[check]!.run!], {
      cwd: new URL("../", import.meta.url).pathname,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_VERSION: version },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    return { stderr, code };
  };
  const failed = await run(below);
  expect(failed.code).not.toBe(0);
  for (const [name, version] of constants)
    if (version.join(".") === highest.join("."))
      expect(failed.stderr).toContain(
        `${name} needs runner ${highest.join(".")}, but this release is ${below}.`,
      );
  expect((await run(highest.join("."))).code).toBe(0);
  expect((await run([highest[0], highest[1]! + 1, 0].join("."))).code).toBe(0);
});
