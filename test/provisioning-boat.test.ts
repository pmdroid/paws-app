import { describe, expect, test } from "bun:test";
import {
  BOAT_ENDPOINT,
  createBoat,
  ProvisioningError,
  type ExeDevFetch,
  type ProvisioningErrorCode,
  type VmState,
} from "../src/provisioning";

const TOKEN = "boat_fake-test-key-0123456789";
const ID = "bx_a1b2c3d4";

type Sent = { url: string; method: string; body: unknown; headers: Headers };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(
  respond: (sent: Sent) => Response | Promise<Response>,
  options: { token?: string | null; ids?: Record<string, string> } = {},
) {
  const sent: Sent[] = [];
  const fetch: ExeDevFetch = async (url, init) => {
    const entry = {
      url,
      method: String(init.method),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: new Headers(init.headers),
    };
    sent.push(entry);
    return respond(entry);
  };
  const ids = options.ids ?? { "ada-paws": ID };
  const boat = createBoat({
    fetch,
    readToken: () => (options.token === undefined ? TOKEN : options.token),
    lookup: (name) => ids[name] ?? null,
  });
  return { boat, sent };
}

async function failure(promise: Promise<unknown>): Promise<ProvisioningError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ProvisioningError);
  return error as ProvisioningError;
}

const created = (id = ID) =>
  json(
    {
      ok: true,
      type: "sandbox.created",
      status: "provisioning",
      ttlSeconds: null,
      sandbox: { id, name: "ada-paws", state: "provisioning" },
    },
    202,
  );

describe("boat client", () => {
  test("create sends auto-stop off, the type for the size and the key as Idempotency-Key", async () => {
    const { boat, sent } = client(() => created());
    expect(await boat.createVm("ada-paws", { cpu: 8, memoryGb: 16 }, { key: "row-1" })).toEqual({
      name: "ada-paws",
      id: ID,
    });
    await boat.createVm("ada-paws", { cpu: 8, memoryGb: 16 }, { key: "row-1" });
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.url).toBe(`${BOAT_ENDPOINT}/sandboxes`);
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(request.headers.get("idempotency-key")).toBe("row-1");
      expect(request.body).toEqual({
        name: "ada-paws",
        type: "large",
        ttlSeconds: null,
        labels: { paws: "runner" },
      });
    }
  });

  test("each size maps to its boat type, and a missing size is default", async () => {
    const { boat, sent } = client(() => created());
    const sizes = [
      undefined,
      { cpu: 2, memoryGb: 4 },
      { cpu: 4, memoryGb: 8 },
      { cpu: 16, memoryGb: 32 },
    ];
    for (const size of sizes) await boat.createVm("ada-paws", size, { key: "k" });
    expect(sent.map((request) => (request.body as { type: string }).type)).toEqual([
      "default",
      "small",
      "default",
      "xlarge",
    ]);
  });

  test("a 6 vCPU size is refused without a request", async () => {
    const { boat, sent } = client(() => created());
    const error = await failure(boat.createVm("ada-paws", { cpu: 6, memoryGb: 12 }, { key: "k" }));
    expect(error.message).toBe("boat has no 6 vCPU / 12 GB size. Use 2/4, 4/8, 8/16 or 16/32.");
    expect(sent).toHaveLength(0);
  });

  test("a plan that refuses auto-stop off fails the create without a retry", async () => {
    const { boat, sent } = client(() =>
      json({ ok: false, code: "trial_auto_stop_required", message: "Trial sandboxes stop." }, 403),
    );
    const error = await failure(boat.createVm("ada-paws", undefined, { key: "k" }));
    expect(error.message).toBe(
      "boat's plan does not allow turning auto-stop off; a runner VM needs that.",
    );
    expect(error.detail).toBe("trial_auto_stop_required: Trial sandboxes stop.");
    expect(sent).toHaveLength(1);
  });

  test("each boat state maps to a VM state", async () => {
    const states: Record<string, VmState> = {
      ready: "running",
      idle: "running",
      running: "running",
      init: "starting",
      provisioning: "starting",
      provisioned: "starting",
      cloning: "starting",
      archiving: "stopping",
      archived: "stopped",
      error: "error",
      cancelled: "error",
      melting: "unknown",
    };
    for (const [state, expected] of Object.entries(states)) {
      const { boat, sent } = client(() => json({ ok: true, sandbox: { id: ID, state } }));
      expect(await boat.getVm("ada-paws")).toEqual({
        name: "ada-paws",
        status: state,
        state: expected,
      });
      expect(sent[0]?.url).toBe(`${BOAT_ENDPOINT}/sandboxes/${ID}`);
      expect(sent[0]?.method).toBe("GET");
    }
  });

  test("a VM without a boat id, or a 404, is missing", async () => {
    const { boat, sent } = client(() => json({ code: "not_found", message: "No sandbox." }, 404));
    expect((await failure(boat.getVm("bob-paws"))).code).toBe("missing");
    expect(sent).toHaveLength(0);
    expect((await failure(boat.getVm("ada-paws"))).code).toBe("missing");
    expect(await boat.deleteVm("bob-paws")).toBe("missing");
    expect(await boat.deleteVm("ada-paws")).toBe("missing");
  });

  test("exec returns the exit code and output, with the timeout in seconds", async () => {
    const { boat, sent } = client(() =>
      json({ ok: true, exitCode: 3, stdout: "out\n", stderr: "err\n", timedOut: false }),
    );
    expect(await boat.execVm("ada-paws", "echo hi", { timeoutMs: 25_500 })).toEqual({
      exitCode: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
    await boat.execVm("ada-paws", "echo hi", { timeoutMs: 1 });
    await boat.execVm("ada-paws", "echo hi", { timeoutMs: 3_600_000 });
    expect(sent[0]?.url).toBe(`${BOAT_ENDPOINT}/sandboxes/${ID}/commands`);
    expect(sent.map((request) => request.body)).toEqual([
      { command: "echo hi", timeoutSeconds: 26 },
      { command: "echo hi", timeoutSeconds: 1 },
      { command: "echo hi", timeoutSeconds: 600 },
    ]);
  });

  test("a timed-out command raises timeout", async () => {
    const { boat } = client(() =>
      json({ ok: true, exitCode: null, stdout: "", stderr: "", timedOut: true }),
    );
    expect((await failure(boat.execVm("ada-paws", "sleep 900"))).code).toBe("timeout");
  });

  test("delete sends the confirm header with the id", async () => {
    const { boat, sent } = client(() => json({ ok: true }, 202));
    expect(await boat.deleteVm("ada-paws")).toBe("deleted");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("DELETE");
    expect(sent[0]?.url).toBe(`${BOAT_ENDPOINT}/sandboxes/${ID}`);
    expect(sent[0]?.headers.get("x-ascii-confirm-delete")).toBe(ID);
  });

  test("HTTP errors map to provisioning codes and no error text carries the key", async () => {
    const cases: [number, string, ProvisioningErrorCode][] = [
      [401, "unauthorized", "unauthorized"],
      [403, "machine_class_plan_required", "unauthorized"],
      [404, "not_found", "missing"],
      [409, "sandbox_not_ready", "conflict"],
      [429, "rate_limited", "rate_limited"],
      [503, "service_unavailable", "unknown"],
    ];
    for (const [status, code, expected] of cases) {
      const { boat } = client(() =>
        json({ ok: false, code, message: `Refused key ${TOKEN}.` }, status),
      );
      const error = await failure(boat.execVm("ada-paws", "true"));
      expect(error.code).toBe(expected);
      expect(error.status).toBe(status);
      expect(error.detail).toBe(`${code}: Refused key [redacted].`);
      expect(`${error.message} ${error.detail}`).not.toContain(TOKEN);
    }
  });

  test("a missing key is no_token, before any request", async () => {
    const { boat, sent } = client(() => created(), { token: null });
    expect((await failure(boat.createVm("ada-paws", undefined, { key: "k" }))).code).toBe(
      "no_token",
    );
    expect(sent).toHaveLength(0);
  });
});
