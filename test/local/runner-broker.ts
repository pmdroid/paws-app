import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createRunnerBrokerClient } from "../../src/runner-execution";

const root = mkdtempSync(join(tmpdir(), "paws-broker-verification-"));
const repository = resolve(import.meta.dir, "../..");
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sourceHashes = Object.fromEntries(
  [
    ".agents/skills/verify-paws/SKILL.md",
    "test/boundaries.test.ts",
    "package.json",
    "bun.lock",
    ...["commands", "index", "signature"].map((name) => `src/runner-protocol/${name}.ts`),
    ...["broker", "index", "jobs", "results", "spool"].map(
      (name) => `src/runner-execution/${name}.ts`,
    ),
    "test/runner-execution.test.ts",
    "test/local/runner-execution-process.ts",
    "test/local/runner-broker-proof.py",
    "test/local/runner-broker.ts",
    ...[
      "runner-broker.py",
      "paws-agent@.service",
      "paws-runner.service",
      "paws-runner-broker.service",
      "paws-runner-broker.socket",
      "paws-runner.sysusers",
      "paws-runner.tmpfiles",
    ].map((name) => `deploy/linux/${name}`),
  ].map((path) => [path, digest(join(repository, path))]),
);
const unit = `paws-agent-proof-${randomUUID()}`;
const env = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}`,
  DOCKER_CONFIG: join(root, "docker-config"),
  DOCKER_HOST:
    process.env.PAWS_BROKER_PROOF_DOCKER_HOST ??
    `unix:///run/user/${process.getuid!()}/docker.sock`,
};
async function run(argumentsList: string[], name: string, success = true) {
  const commandProcess = Bun.spawn(argumentsList, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(commandProcess.stdout).text(),
    new Response(commandProcess.stderr).text(),
    commandProcess.exited,
  ]);
  writeFileSync(join(root, `${name}.log`), stdout + stderr);
  if ((exit === 0) !== success) throw new Error(`${name} failed (${exit}); evidence ${root}`);
  return stdout;
}

console.log(`Evidence ${root}`);
const artifact = join(root, "production-spool.js");
const build = await Bun.build({
  entrypoints: [join(repository, "test/local/runner-execution-process.ts")],
  target: "bun",
  outdir: root,
  naming: "production-spool.js",
});
if (!build.success) throw new Error("Production spool probe build failed");
const image = process.env.PAWS_BROKER_PROOF_IMAGE ?? "python:3.14-slim";
const answerProbe = process.env.PAWS_BROKER_PROOF_ANSWER_BINARY;
const imageId = await run(["docker", "image", "inspect", "--format", "{{.Id}}", image], "image");
const namespaceOutput = await run(
  [
    "docker",
    "run",
    "--pull=never",
    "--rm",
    "--user",
    "0",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    ...["CHOWN", "FOWNER", "DAC_OVERRIDE", "SETUID", "SETGID"].flatMap((capability) => [
      "--cap-add",
      capability,
    ]),
    "--security-opt",
    "no-new-privileges",
    ...[
      [join(repository, "deploy/linux/runner-broker.py"), "/proof/runner-broker.py"],
      [join(repository, "test/local/runner-broker-proof.py"), "/proof/proof.py"],
      [artifact, "/proof/production-spool.js"],
      [process.execPath, "/proof/bun"],
      ...(answerProbe ? [[resolve(answerProbe), "/proof/answers"]] : []),
    ].flatMap(([source, destination]) => [
      "--mount",
      `type=bind,src=${source},dst=${destination},readonly`,
    ]),
    "--entrypoint",
    "/usr/bin/env",
    image,
    "python3",
    "-I",
    "/proof/proof.py",
    "/proof/runner-broker.py",
    "/proof/production-spool.js",
    "/proof/bun",
    ...(answerProbe ? ["/proof/answers"] : []),
  ],
  "uids-and-broker",
);

const delayedSocketPath = join(root, "delayed-broker.sock");
const delayedServer = createServer((socket) => {
  socket.once("data", () => {
    setTimeout(() => socket.end('{"ok":true,"alreadyAdmitted":false}\n'), 61_000);
  });
});
await new Promise<void>((ready, reject) => {
  delayedServer.once("error", reject);
  delayedServer.listen(delayedSocketPath, ready);
});
const delayedStartAt = performance.now();
const delayedStart = createRunnerBrokerClient({ socketPath: delayedSocketPath })
  .start("01K00000000000000000000000")
  .finally(() => delayedServer.close());
const shippedUnit = readFileSync(join(repository, "deploy/linux/paws-agent@.service"), "utf8");
const killMode = shippedUnit.match(/^KillMode=(.+)$/m)?.[1];
const killSignal = shippedUnit.match(/^KillSignal=(.+)$/m)?.[1];
const startTimeout = shippedUnit.match(/^TimeoutStartSec=(.+)$/m)?.[1];
const stopTimeout = shippedUnit.match(/^TimeoutStopSec=(.+)$/m)?.[1];
if (
  killMode !== "control-group" ||
  killSignal !== "SIGKILL" ||
  startTimeout !== "30s" ||
  stopTimeout !== "30s"
)
  throw new Error("Worker unit process fencing changed");
const startDeadline = performance.now();
await run(
  [
    "systemd-run",
    "--user",
    "--wait",
    "--collect",
    `--unit=${unit}-deadline`,
    "--property=Type=exec",
    `--property=TimeoutStartSec=${startTimeout}`,
    "--property=ExecStartPre=/usr/bin/sleep 120",
    "/usr/bin/true",
  ],
  "start-deadline",
  false,
);
const startDeadlineMs = performance.now() - startDeadline;
if (startDeadlineMs < 29_000 || startDeadlineMs >= 45_000)
  throw new Error("Worker activation deadline exceeds broker acknowledgement deadline");
const childScript = join(root, "child-tree.py");
const pidsPath = join(root, "pids.json");
writeFileSync(
  childScript,
  `import json,os,signal,subprocess,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nchild=subprocess.Popen(["/usr/bin/python3","-c","import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(120)"])\nwhile os.getsid(child.pid)!=child.pid: time.sleep(0.01)\nopen(${JSON.stringify(pidsPath)},"w").write(json.dumps({"parent":os.getpid(),"child":child.pid,"parentSession":os.getsid(0),"childSession":os.getsid(child.pid)}))\ntime.sleep(120)\n`,
);
const cgroupProof = [];
for (const explicitKill of [true, false]) {
  const activeUnit = `${unit}-${explicitKill}`;
  let started = false;
  rmSync(pidsPath, { force: true });
  try {
    await run(
      [
        "systemd-run",
        "--user",
        `--unit=${activeUnit}`,
        `--property=KillMode=${killMode}`,
        `--property=KillSignal=${killSignal}`,
        `--property=TimeoutStopSec=${stopTimeout}`,
        "/usr/bin/python3",
        childScript,
      ],
      `start-cgroup-${explicitKill}`,
    );
    started = true;
    for (let attempts = 0; !existsSync(pidsPath) && attempts < 100; attempts++) await Bun.sleep(50);
    const pids = JSON.parse(readFileSync(pidsPath, "utf8")) as {
      parent: number;
      child: number;
      parentSession: number;
      childSession: number;
    };
    if (pids.childSession !== pids.child || pids.parentSession === pids.childSession)
      throw new Error("Child did not detach its session");
    const stopStarted = performance.now();
    if (explicitKill)
      await run(
        [
          "systemctl",
          "--user",
          "kill",
          "--kill-whom=all",
          "--signal=SIGKILL",
          `${activeUnit}.service`,
        ],
        "kill-cgroup",
      );
    await run(
      ["systemctl", "--user", "stop", `${activeUnit}.service`],
      `stop-cgroup-${explicitKill}`,
    );
    const stopElapsedMs = performance.now() - stopStarted;
    if (stopElapsedMs >= 5_000)
      throw new Error("Immediate resistant-child fencing exceeded budget");
    started = false;
    if (existsSync(`/proc/${pids.parent}`) || existsSync(`/proc/${pids.child}`))
      throw new Error("Stopped worker retained descendants");
    cgroupProof.push({ pids, explicitKill, stopElapsedMs });
  } finally {
    if (started)
      await run(["systemctl", "--user", "stop", `${activeUnit}.service`], "cleanup-cgroup");
    await run(
      ["systemctl", "--user", "reset-failed", `${activeUnit}.service`],
      "reset-cgroup",
    ).catch(() => {});
  }
}
await delayedStart;
const delayedStartMs = performance.now() - delayedStartAt;
if (delayedStartMs < 61_000) throw new Error("Start acknowledgement was not delayed");
for (const [path, sha256] of Object.entries(sourceHashes))
  if (digest(join(repository, path)) !== sha256) throw new Error(`Source changed: ${path}`);
writeFileSync(
  join(root, "observations.json"),
  JSON.stringify(
    {
      passed: true,
      image: imageId.trim(),
      bunVersion: Bun.version,
      bunSha256: digest(process.execPath),
      sourceHashes,
      compiledSpoolSha256: digest(artifact),
      brokerSha256: digest(join(repository, "deploy/linux/runner-broker.py")),
      workerUnitSha256: digest(join(repository, "deploy/linux/paws-agent@.service")),
      actualPeerCredentials: true,
      namespacePythonVersion: (JSON.parse(namespaceOutput) as { pythonVersion: string })
        .pythonVersion,
      actualDistinctUids: true,
      actualAnswerUidBoundary: Boolean(answerProbe),
      answerProbeSha256: answerProbe ? digest(resolve(answerProbe)) : null,
      brokerCapability: "CAP_CHOWN",
      systemctlBackendInNamespace: "recording fake",
      realUserSystemdCgroup: true,
      cgroupProof,
      killMode,
      killSignal,
      startTimeout,
      startDeadlineMs,
      stopTimeout,
      delayedStartMs,
    },
    null,
    2,
  ),
);
console.log(
  `VERIFIED broker UID boundary, fixed command admission, durable replay and real cgroup termination; evidence ${root}`,
);
