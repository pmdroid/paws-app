import { describe, expect, test } from "bun:test";
import { createBoat, createInstaBox, type ExeDevFetch } from "../src/provisioning";
import { boatKeyCheck, instaBoxKeyCheck } from "../src/vm-provider-checks";

type Sent = { url: string; method: string };

function fakeFetch(respond: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch: ExeDevFetch = async (url, init) => {
    const entry = { url, method: String(init.method) };
    sent.push(entry);
    return respond(entry);
  };
  return { fetch, sent };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const signal = new AbortController().signal;
const spec = (vcpus: number, memMiB: number) => ({ vcpus, memMiB, persistentDiskGiB: 20 });

function boat(respond: (sent: Sent) => Response | Promise<Response>) {
  const { fetch, sent } = fakeFetch(respond);
  const client = createBoat({
    fetch,
    readToken: () => "boat-key",
    lookup: () => null,
    timeoutMs: { listVms: 20 },
  });
  return { check: boatKeyCheck(client), sent };
}

function instaBox(specs: unknown[]) {
  const { fetch, sent } = fakeFetch(({ url }) =>
    url.endsWith("/v1/orgs")
      ? json({ orgs: [{ id: "org_1", allowedSpecs: specs }] })
      : json({ machines: [{ id: "m_1", state: "suspended" }], nextCursor: null }),
  );
  const client = createInstaBox({ fetch, readToken: () => "ibx-key", lookup: () => null });
  return { check: instaBoxKeyCheck(client), sent };
}

describe("boat key check", () => {
  test("a working sandbox list is working", async () => {
    const { check, sent } = boat(() =>
      json({
        ok: true,
        sandboxes: [
          { id: "bx_1", state: "idle" },
          { id: "bx_2", state: "archived" },
        ],
      }),
    );
    expect(await check(signal)).toEqual({
      state: "working",
      message: "boat accepted the key.",
      facts: [
        { name: "key", text: "boat accepted the key", level: "ok" },
        { name: "vms", text: "2 sandboxes, 1 not running", level: "ok" },
      ],
    });
    expect(sent).toEqual([{ url: "https://boat.dev/api/v1/sandboxes?limit=200", method: "GET" }]);
  });

  test("401 is rejected, a timeout and a 503 are unreachable", async () => {
    expect(await boat(() => json({ code: "unauthorized" }, 401)).check(signal)).toMatchObject({
      state: "rejected",
      message: "boat refused the key (HTTP 401).",
    });
    const hung = boat(() => new Promise<Response>(() => {}));
    expect(await hung.check(signal)).toMatchObject({
      state: "unreachable",
      message: "boat did not answer in time.",
    });
    expect(await boat(() => json({}, 503)).check(signal)).toMatchObject({ state: "unreachable" });
    expect(hung.sent.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("InstaBox key check", () => {
  test("a plan with one allowed size is limited with a warn sizes fact", async () => {
    const { check, sent } = instaBox([spec(4, 8192)]);
    expect(await check(signal)).toEqual({
      state: "limited",
      message: "InstaBox accepted the key, but its plan allows only one size.",
      facts: [
        { name: "key", text: "InstaBox accepted the key", level: "ok" },
        { name: "sizes", text: "Only 4 vCPU / 8192 MiB", level: "warn" },
        { name: "vms", text: "1 machine, 1 not running", level: "ok" },
      ],
    });
    expect(sent).toEqual([
      { url: "https://api.instabox.sh/v1/machines", method: "GET" },
      { url: "https://api.instabox.sh/v1/orgs", method: "GET" },
    ]);
  });

  test("a plan with several sizes is working", async () => {
    expect(await instaBox([spec(4, 8192), spec(8, 16384)]).check(signal)).toMatchObject({
      state: "working",
      facts: [
        { name: "key", level: "ok" },
        { name: "sizes", text: "4 vCPU / 8192 MiB, 8 vCPU / 16384 MiB", level: "ok" },
        { name: "vms", level: "ok" },
      ],
    });
  });

  test("403 is rejected", async () => {
    const { fetch } = fakeFetch(() => json({ error: { code: "forbidden" } }, 403));
    const client = createInstaBox({ fetch, readToken: () => "ibx-key", lookup: () => null });
    expect(await instaBoxKeyCheck(client)(signal)).toMatchObject({
      state: "rejected",
      message: "InstaBox refused the key (HTTP 403).",
    });
  });
});
