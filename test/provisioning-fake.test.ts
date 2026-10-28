import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLayout,
  exeDevTokenPath,
  exeDevTokenStatus,
  pawsPaths,
  tailscaleAuthKeyPath,
  tailscaleAuthKeyStatus,
} from "../src/config";
import { writeSecretFile } from "../src/credentials";
import {
  createFakeExeDev,
  exeDevTokenReader,
  FAKE_UNSCRIPTED_EXIT,
  isTailnetUrl,
  ProvisioningError,
  tailscaleAuthKeyReader,
} from "../src/provisioning";

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    return (error as ProvisioningError).code;
  }
  throw new Error("expected a ProvisioningError");
}

test("the fake creates, lists and records every call", async () => {
  const exe = createFakeExeDev();
  expect(await exe.createVm("ada-paws")).toEqual({
    name: "ada-paws",
    sshDest: "ada-paws.exe.xyz",
    httpsUrl: "https://ada-paws.exe.xyz",
  });
  expect(await code(exe.createVm("ada-paws"))).toBe("conflict");
  expect((await exe.getVm("ada-paws")).status).toBe("running");
  exe.setStatus("ada-paws", "stopped");
  expect((await exe.getVm("ada-paws")).status).toBe("stopped");
  expect(await code(exe.getVm("bob-paws"))).toBe("missing");
  expect(await code(exe.getVm("Bob"))).toBe("invalid_name");
  expect(exe.calls).toEqual([
    { operation: "createVm", vm: "ada-paws", command: "new --name=ada-paws" },
    { operation: "createVm", vm: "ada-paws", command: "new --name=ada-paws" },
    { operation: "getVm", vm: "ada-paws" },
    { operation: "getVm", vm: "ada-paws" },
    { operation: "getVm", vm: "bob-paws" },
    { operation: "getVm", vm: "Bob" },
  ]);
});

test("configured sizes become `new` flags, and no size is a bare `new`", async () => {
  const exe = createFakeExeDev();
  await exe.createVm("ada-paws");
  await exe.createVm("bob-paws", {});
  await exe.createVm("cy-paws", { cpu: 8, memoryGb: 16, diskGb: 100, image: "ubuntu:24.04" });
  await exe.createVm("dee-paws", { cpu: 4 });
  expect(exe.calls.map((call) => (call.operation === "createVm" ? call.command : null))).toEqual([
    "new --name=ada-paws",
    "new --name=bob-paws",
    "new --name=cy-paws --cpu=8 --disk=100GB --image=ubuntu:24.04 --memory=16GB",
    "new --name=dee-paws --cpu=4",
  ]);
  for (const size of [{ cpu: 0 }, { memoryGb: -4 }, { diskGb: 1.5 }, { image: "a b; rm -rf /" }])
    expect(await code(exe.createVm("eve-paws", size))).toBe("invalid_command");
  expect(exe.vms.has("eve-paws")).toBe(false);
});

test("the fake places VMs in listed pools and refuses an unknown pool as exe.dev does", async () => {
  const exe = createFakeExeDev();
  exe.addPool("build", { region: "lon" });
  await exe.createVm("ada-paws", { pool: "build" });
  expect(exe.placement.get("ada-paws")).toBe("build");
  await expect(exe.createVm("bob-paws", { pool: "gpu" })).rejects.toThrow(
    'exe.dev refused Create VM for bob-paws with --pool=gpu: pool "gpu" does not exist. Change [member_vm] in config.toml or choose another pool.',
  );
  expect(exe.vms.has("bob-paws")).toBe(false);
  expect(await exe.listPools()).toEqual([{ name: "build", region: "lon", status: "active" }]);
  await exe.createVm("cy-paws");
  await exe.adoptVm("cy-paws", "build");
  expect(exe.placement.get("cy-paws")).toBe("build");
  expect(await code(exe.adoptVm("dee-paws", "build"))).toBe("missing");
  expect(await code(exe.adoptVm("cy-paws", "gpu"))).toBe("unknown");
});

test("the fake deletes a VM, answers missing for an unknown one, and fails when told to", async () => {
  const exe = createFakeExeDev();
  exe.addVm("ada-paws");
  expect(await exe.deleteVm("ada-paws")).toBe("deleted");
  expect(exe.vms.has("ada-paws")).toBe(false);
  expect(await exe.deleteVm("ada-paws")).toBe("missing");
  exe.addVm("bob-paws");
  exe.fail("deleteVm", "missing", { vm: "bob-paws" });
  expect(await exe.deleteVm("bob-paws")).toBe("missing");
  exe.fail("deleteVm", "unauthorized");
  expect(await code(exe.deleteVm("bob-paws"))).toBe("unauthorized");
  expect(await code(exe.deleteVm("Bob"))).toBe("invalid_name");
  expect(exe.calls.filter((call) => call.operation === "deleteVm")).toHaveLength(5);
  expect(await exe.createVm("ada-paws")).toMatchObject({ name: "ada-paws" });
});

test("the fake returns scripted exec results per VM and command", async () => {
  const exe = createFakeExeDev();
  exe.addVm("ada-paws");
  exe.addVm("bob-paws");
  exe.scriptExec("ada-paws", "paws-runner runner daemon", { stdout: "code ABCD-1234\n" });
  exe.scriptExec("ada-paws", /^curl /, [{ exitCode: 7, stderr: "down" }, { exitCode: 0 }]);
  exe.scriptExec("bob-paws", "uname", (command, vm) => ({ stdout: `${vm}:${command}` }));

  expect(await exe.execVm("ada-paws", "paws-runner runner daemon")).toEqual({
    exitCode: 0,
    stdout: "code ABCD-1234\n",
    stderr: "",
  });
  expect((await exe.execVm("ada-paws", "curl -fsS install")).exitCode).toBe(7);
  expect((await exe.execVm("ada-paws", "curl -fsS install")).exitCode).toBe(0);
  expect((await exe.execVm("ada-paws", "curl -fsS install")).exitCode).toBe(0);
  expect((await exe.execVm("bob-paws", "uname", { timeoutMs: 5 })).stdout).toBe("bob-paws:uname");
  const unscripted = await exe.execVm("bob-paws", "paws-runner runner daemon");
  expect(unscripted.exitCode).toBe(FAKE_UNSCRIPTED_EXIT);
  expect(await code(exe.execVm("carol-paws", "true"))).toBe("missing");
  expect(await code(exe.execVm("ada-paws", ""))).toBe("invalid_command");
  expect(exe.calls.at(4)).toEqual({
    operation: "execVm",
    vm: "bob-paws",
    command: "uname",
    timeoutMs: 5,
  });
  expect(exe.calls).toHaveLength(8);
});

test("the fake fails an operation when told to", async () => {
  const exe = createFakeExeDev();
  exe.fail("createVm", "rate_limited", { status: 429 });
  const error = await exe.createVm("ada-paws").catch((caught: unknown) => caught);
  expect(error).toMatchObject({ operation: "createVm", code: "rate_limited", status: 429 });
  expect(exe.vms.has("ada-paws")).toBe(false);
  await exe.createVm("ada-paws");

  exe.fail("execVm", "timeout", { vm: "ada-paws", command: /install/, times: 2 });
  expect(await code(exe.execVm("ada-paws", "run install"))).toBe("timeout");
  expect((await exe.execVm("ada-paws", "true")).exitCode).toBe(FAKE_UNSCRIPTED_EXIT);
  expect(await code(exe.execVm("ada-paws", "run install"))).toBe("timeout");
  expect((await exe.execVm("ada-paws", "run install")).exitCode).toBe(FAKE_UNSCRIPTED_EXIT);

  exe.fail("getVm", "unauthorized", { times: Infinity });
  expect(await code(exe.getVm("ada-paws"))).toBe("unauthorized");
  expect(await code(exe.getVm("ada-paws"))).toBe("unauthorized");
});

test("the token reader reads ~/.paws/secrets/exe-dev-token through readSecretFile", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-exe-dev-"));
  ensureLayout(pawsPaths(home));
  const read = exeDevTokenReader(home);
  expect(exeDevTokenStatus(home)).toBe("absent");
  expect(read()).toBeNull();

  writeFileSync(exeDevTokenPath(home), "  \n", { mode: 0o600 });
  expect(exeDevTokenStatus(home)).toBe("empty");

  writeSecretFile(exeDevTokenPath(home), "exe1.first\n");
  expect(exeDevTokenStatus(home)).toBe("readable");
  expect(read()).toBe("exe1.first");
  writeSecretFile(exeDevTokenPath(home), "exe1.second");
  expect(read()).toBe("exe1.second");

  writeFileSync(join(pawsPaths(home).secretsDir, ".envelope-key"), Buffer.alloc(32, 1));
  expect(exeDevTokenStatus(home)).toBe("unreadable");
  expect(() => read()).toThrow(/Could not decrypt/);
});

test("the auth key reader reads ~/.paws/secrets/tailscale-authkey through readSecretFile", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-tailscale-"));
  ensureLayout(pawsPaths(home));
  const read = tailscaleAuthKeyReader(home);
  expect(tailscaleAuthKeyPath(home)).toBe(join(pawsPaths(home).secretsDir, "tailscale-authkey"));
  expect(tailscaleAuthKeyStatus(home)).toBe("absent");
  expect(read()).toBeNull();

  writeFileSync(tailscaleAuthKeyPath(home), "\n", { mode: 0o600 });
  expect(tailscaleAuthKeyStatus(home)).toBe("empty");
  expect(read()).toBeNull();

  writeSecretFile(tailscaleAuthKeyPath(home), "tskey-auth-first\n");
  expect(tailscaleAuthKeyStatus(home)).toBe("readable");
  expect(read()).toBe("tskey-auth-first");

  writeFileSync(join(pawsPaths(home).secretsDir, ".envelope-key"), Buffer.alloc(32, 1));
  expect(tailscaleAuthKeyStatus(home)).toBe("unreadable");
});

test("only a *.ts.net host counts as a tailnet URL", () => {
  expect(isTailnetUrl("https://agentbox.taile07e4.ts.net:8787")).toBe(true);
  expect(isTailnetUrl("https://paws.example.com")).toBe(false);
  expect(isTailnetUrl("https://ts.net.example.com")).toBe(false);
  expect(isTailnetUrl("not a url")).toBe(false);
  expect(isTailnetUrl(null)).toBe(false);
});
