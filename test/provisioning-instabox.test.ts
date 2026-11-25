import { describe, expect, test } from "bun:test";
import {
  createInstaBox,
  INSTABOX_ENDPOINT,
  INSTABOX_TEMPLATE,
  ProvisioningError,
  type ExeDevFetch,
  type ProvisioningErrorCode,
} from "../src/provisioning";

const KEY = "ibk_fake0test0key0do0not0use";
const ID = "m_01k0000000000000000000000a";

type Sent = { url: string; method: string; headers: Headers; body: unknown };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(
  respond: (sent: Sent) => Response,
  options: { token?: string | null; ids?: Record<string, string> } = {},
) {
  const sent: Sent[] = [];
  const fetch: ExeDevFetch = async (url, init) => {
    const entry = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    sent.push(entry);
    return respond(entry);
  };
  const ids = options.ids ?? { "ada-paws": ID };
  const box = createInstaBox({
    fetch,
    readToken: () => (options.token === undefined ? KEY : options.token),
    lookup: (name) => ids[name] ?? null,
  });
  return { box, sent };
}

async function failure(promise: Promise<unknown>): Promise<ProvisioningError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProvisioningError) return error;
    throw error;
  }
  throw new Error("expected a ProvisioningError");
}

describe("InstaBox client", () => {
  test("create sends the template, no idle pause, no run limit and the key, and returns the machine id", async () => {
    const { box, sent } = client(() =>
      json(202, { id: "op_1", machineId: ID, type: "create", state: "queued" }),
    );
    const created = await box.createVm("ada-paws", { cpu: 4, memoryGb: 8 }, { key: "row-1" });
    expect(box.id).toBe("instabox");
    expect(created.id).toBe(ID);
    expect(created.name).toBe("ada-paws");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${INSTABOX_ENDPOINT}/v1/machines`);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.headers.get("Idempotency-Key")).toBe("row-1");
    expect(sent[0]!.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(sent[0]!.body).toEqual({
      name: "ada-paws",
      templateId: INSTABOX_TEMPLATE,
      autoSuspendAfterSeconds: 0,
      maxRunMinutes: -1,
      vcpus: 4,
      memMiB: 8192,
    });
    expect(INSTABOX_TEMPLATE).toBe("agent-browser");
  });

  test("create without a size sends neither vcpus nor memMiB", async () => {
    const { box, sent } = client(() => json(202, { id: "op_1", machineId: ID, state: "queued" }));
    await box.createVm("ada-paws", {}, { key: "row-1" });
    expect(sent[0]!.body).toEqual({
      name: "ada-paws",
      templateId: INSTABOX_TEMPLATE,
      autoSuspendAfterSeconds: 0,
      maxRunMinutes: -1,
    });
  });

  test("create refuses a size InstaBox does not offer before calling it", async () => {
    const { box, sent } = client(() => json(202, { id: "op_1", machineId: ID, state: "queued" }));
    const error = await failure(box.createVm("ada-paws", { cpu: 3, memoryGb: 8 }, { key: "k" }));
    expect(error.message).toStartWith("InstaBox has no 3 vCPU / 8 GB size.");
    expect(sent).toHaveLength(0);
  });

  test("each InstaBox state maps to a VM state", async () => {
    const expected = {
      running: "running",
      creating: "starting",
      starting: "starting",
      resuming: "starting",
      stopping: "stopping",
      suspending: "stopping",
      stopped: "stopped",
      suspended: "stopped",
      error: "error",
      deleting: "unknown",
      deleted: "unknown",
      hibernating: "unknown",
    } as const;
    for (const [state, mapped] of Object.entries(expected)) {
      const { box, sent } = client(() => json(200, { id: ID, name: "ada-paws", state }));
      const vm = await box.getVm("ada-paws");
      expect({ state, mapped: vm.state }).toEqual({ state, mapped });
      expect(vm.status).toBe(state);
      expect(sent[0]!.url).toBe(`${INSTABOX_ENDPOINT}/v1/machines/${ID}`);
      expect(sent[0]!.method).toBe("GET");
    }
  });

  test("a name without a stored id and a 404 are missing", async () => {
    const none = client(() => json(200, {}));
    expect((await failure(none.box.getVm("bob-paws"))).code).toBe("missing");
    expect(none.sent).toHaveLength(0);
    const gone = client(() =>
      json(404, { error: { code: "not_found", message: "no such sandbox" } }),
    );
    expect((await failure(gone.box.getVm("ada-paws"))).code).toBe("missing");
  });

  test("exec sends cmd and timeoutSeconds and returns the exit code and output", async () => {
    const { box, sent } = client(() =>
      json(200, {
        exitCode: 3,
        stdout: "out\n",
        stderr: "err\n",
        timedOut: false,
        truncated: false,
      }),
    );
    expect(await box.execVm("ada-paws", "echo hi", { timeoutMs: 25_001 })).toEqual({
      exitCode: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
    expect(sent[0]!.url).toBe(`${INSTABOX_ENDPOINT}/v1/machines/${ID}/exec`);
    expect(sent[0]!.body).toEqual({ cmd: "echo hi", timeoutSeconds: 26 });
    await box.execVm("ada-paws", "true", { timeoutMs: 3_600_000 });
    expect(sent[1]!.body).toEqual({ cmd: "true", timeoutSeconds: 600 });
    await box.execVm("ada-paws", "true", { timeoutMs: 1 });
    expect(sent[2]!.body).toEqual({ cmd: "true", timeoutSeconds: 1 });
  });

  test("a timed-out command raises timeout", async () => {
    const { box } = client(() =>
      json(200, { exitCode: 124, stdout: "", stderr: "", timedOut: true, truncated: false }),
    );
    const error = await failure(box.execVm("ada-paws", "sleep 100", { timeoutMs: 5_000 }));
    expect(error.code).toBe("timeout");
    expect(error.operation).toBe("execVm");
  });

  test("delete sends the confirm header and an idempotency key from the id", async () => {
    const { box, sent } = client(() => json(202, { id: "op_2", machineId: ID, state: "queued" }));
    expect(await box.deleteVm("ada-paws")).toBe("deleted");
    expect(sent[0]!.url).toBe(`${INSTABOX_ENDPOINT}/v1/machines/${ID}`);
    expect(sent[0]!.method).toBe("DELETE");
    expect(sent[0]!.headers.get("X-Confirm-Delete")).toBe(ID);
    expect(sent[0]!.headers.get("Idempotency-Key")).toBe(`paws-delete-${ID}`);
  });

  test("delete of a 404 or a name without an id is missing", async () => {
    const gone = client(() => json(404, { error: { code: "not_found", message: "gone" } }));
    expect(await gone.box.deleteVm("ada-paws")).toBe("missing");
    const none = client(() => json(202, {}));
    expect(await none.box.deleteVm("bob-paws")).toBe("missing");
    expect(none.sent).toHaveLength(0);
  });

  test("HTTP errors map to provisioning codes, and no error text contains the key", async () => {
    const cases: [number, string, ProvisioningErrorCode][] = [
      [401, "invalid_key", "unauthorized"],
      [403, "missing_scope", "unauthorized"],
      [404, "not_found", "missing"],
      [409, "machine_not_running", "conflict"],
      [429, "rate_limited", "rate_limited"],
      [402, "credit_exhausted", "unknown"],
      [503, "no_capacity", "unknown"],
    ];
    for (const [status, code, mapped] of cases) {
      const { box } = client(() =>
        json(status, {
          error: { code, message: `key ${KEY} refused`, retryable: false },
        }),
      );
      const error = await failure(box.execVm("ada-paws", "true"));
      expect({ status, code: error.code }).toEqual({ status, code: mapped });
      expect(error.status).toBe(status);
      expect(error.detail).toBe(`${code}: key [redacted] refused`);
      expect(error.message).toContain(code);
      expect(`${error.message} ${error.detail} ${error.stack}`).not.toContain(KEY);
    }
  });

  test("a missing key is no_token and nothing is sent", async () => {
    const { box, sent } = client(() => json(200, {}), { token: null });
    expect((await failure(box.createVm("ada-paws", {}, { key: "k" }))).code).toBe("no_token");
    expect(sent).toHaveLength(0);
  });

  test("a request that never answers is a timeout", async () => {
    const fetch: ExeDevFetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const box = createInstaBox({
      fetch,
      readToken: () => KEY,
      lookup: () => ID,
      timeoutMs: { getVm: 20 },
    });
    expect((await failure(box.getVm("ada-paws"))).code).toBe("timeout");
  });
  test("create from a snapshot sends snapshotId instead of the template", async () => {
    const { box, sent } = client(() => json(202, { machineId: ID }));
    await box.createVm("ada-paws", { cpu: 4, memoryGb: 8 }, { key: "row-2", from: "snap_abc-1" });
    expect(sent[0]!.body).toEqual({
      name: "ada-paws",
      snapshotId: "snap_abc-1",
      autoSuspendAfterSeconds: 0,
      maxRunMinutes: -1,
      vcpus: 4,
      memMiB: 8192,
    });
  });

  test("suspend, resume and start post to the machine id", async () => {
    const { box, sent } = client(() => json(202, { id: "op_2", state: "queued" }));
    await box.suspendVm("ada-paws");
    await box.resumeVm("ada-paws");
    await box.startVm("ada-paws");
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST ${INSTABOX_ENDPOINT}/v1/machines/${ID}/suspend`,
      `POST ${INSTABOX_ENDPOINT}/v1/machines/${ID}/resume`,
      `POST ${INSTABOX_ENDPOINT}/v1/machines/${ID}/start`,
    ]);
    expect((await failure(box.suspendVm("other-vm"))).code).toBe("missing");
  });

  test("the plan reads the first org's tier, always on, start limit and sizes", async () => {
    const org = {
      tier: "pro",
      limits: { alwaysOn: true, startsPerMinute: 30 },
      allowedSpecs: [{ vcpus: 4, memMiB: 8192, persistentDiskGiB: 20 }],
    };
    const { box } = client(() => json(200, { orgs: [org, { ...org, tier: "team" }] }));
    expect(await box.readPlan()).toEqual({
      tier: "pro",
      alwaysOn: true,
      startsPerMinute: 30,
      sizes: [{ vcpus: 4, memMiB: 8192 }],
    });
    const bare = client(() => json(200, { orgs: [{ allowedSpecs: [] }] }));
    expect(await bare.box.listSizes()).toEqual([]);
    expect((await failure(bare.box.readPlan())).code).toBe("invalid_response");
  });

  test("Retry-After is kept on the error", async () => {
    const { box } = client(
      () =>
        new Response(JSON.stringify({ error: { code: "quota_exceeded" } }), {
          status: 429,
          headers: { "retry-after": "7" },
        }),
    );
    const error = await failure(box.resumeVm("ada-paws"));
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(7_000);
  });
});
