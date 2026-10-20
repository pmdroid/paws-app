import { describe, expect, test } from "bun:test";
import { createExeDev, createFakeExeDev, ProvisioningError } from "./index";
import type { CreateVm, ExeDevOptions } from "./index";

const input: CreateVm = { name: "mia-paws-123", cpu: 2, memoryGB: 4 };
const providerVm = {
  vm_name: input.name,
  ssh_dest: "vm+mia-paws-123@vm.exe.xyz",
  ssh_host: "vm.exe.xyz",
  ssh_user: "vm+mia-paws-123",
  https_url: "https://mia-paws-123.exe.xyz",
  status: "starting",
  future_field: true,
};
const terminal = '{"exit_code":0}\n';

function harness(body: string, extra: Partial<ExeDevOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createExeDev({
    readToken: async () => "exe1.fake-token",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(body);
    },
    ...extra,
  });
  return { client, calls };
}

async function errorOf(promise: Promise<unknown>): Promise<ProvisioningError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    return error as ProvisioningError;
  }
  throw new Error("Expected provider failure");
}

function chunks(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
  );
}

describe("exe.dev HTTPS contract", () => {
  test("lists JSON, preserves authoritative routed SSH fields and reads token per request", async () => {
    let reads = 0;
    const { client, calls } = harness(JSON.stringify({ vms: [providerVm] }), {
      readToken: async () => `exe1.fake-${++reads}`,
    });
    const [vm] = await client.listVms();
    expect(vm).toEqual({
      name: input.name,
      sshDestination: providerVm.ssh_dest,
      sshHost: providerVm.ssh_host,
      sshUser: providerVm.ssh_user,
      httpsUrl: providerVm.https_url,
      status: "starting",
    });
    await client.listVms();
    expect(
      calls.map(({ url, init }) => ({
        url,
        method: init.method,
        body: init.body,
        headers: init.headers,
        redirect: init.redirect,
      })),
    ).toEqual(
      [1, 2].map((n) => ({
        url: "https://exe.dev/exec",
        method: "POST",
        body: "ls --json",
        headers: {
          Authorization: `Bearer exe1.fake-${n}`,
          "Content-Type": "text/plain",
          Accept: "application/json",
        },
        redirect: "error",
      })),
    );
  });

  test("creates only explicitly named and sized VM with quoted resource selectors", async () => {
    const { client, calls } = harness(JSON.stringify(providerVm));
    expect(
      await client.createVm({
        ...input,
        pool: "approved-pool",
        image: "registry.example/paws@sha256:abcd",
      }),
    ).toMatchObject({ name: input.name });
    expect(calls[0]?.init.body).toBe(
      "new --name='mia-paws-123' --cpu=2 --memory=4GB --pool='approved-pool' --image='registry.example/paws@sha256:abcd'",
    );
    expect(calls).toHaveLength(1);
  });

  test("tolerates undocumented missing addresses but never invents one", async () => {
    expect(await harness('{"vm_name":"mia-paws-123"}').client.createVm(input)).toEqual({
      name: input.name,
    });
  });

  test("rejects invalid names, flags, resources and oversized commands before token or transport", async () => {
    let reads = 0;
    const { client, calls } = harness("", {
      readToken: async () => {
        reads++;
        return "fake";
      },
    });
    const invalid: CreateVm[] = [
      { ...input, name: "mia; rm all" },
      { ...input, name: "-flag" },
      { ...input, name: "x".repeat(64) },
      { ...input, cpu: 0 },
      { ...input, cpu: 1.5 },
      { ...input, cpu: Infinity },
      { ...input, memoryGB: 0 },
      { ...input, memoryGB: NaN },
      { ...input, pool: "pool --standalone" },
      { ...input, image: "image\nnew" },
      { ...input, image: "--flag" },
      { ...input, image: 123 as unknown as string },
    ];
    for (const value of invalid)
      expect(await errorOf(client.createVm(value))).toMatchObject({
        code: "invalid_input",
        outcome: "not_sent",
      });
    for (const command of ["", "\0", "a".repeat(65536), "🐕".repeat(17000)]) {
      expect(await errorOf(client.execVm({ vmName: input.name, command }))).toMatchObject({
        code: "invalid_input",
      });
    }
    expect(await errorOf(client.execVm({ vmName: "--flag", command: "true" }))).toMatchObject({
      code: "invalid_input",
    });
    expect(reads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("fail-closes malformed JSON, error bodies, duplicate list names and mismatched creation", async () => {
    for (const text of [
      "not json",
      "null",
      "[]",
      "{}",
      '{"vms":null}',
      '{"vms":[{"vm_name":"bad name"}]}',
      '{"vms":[],"error":"private detail"}',
      JSON.stringify({ vms: [providerVm, providerVm] }),
      '{"vms":[{"vm_name":"valid","ssh_host":32}]}',
    ]) {
      expect(await errorOf(harness(text).client.listVms())).toMatchObject({
        code: "invalid_response",
      });
    }
    for (const text of [
      '{"vm_name":"other"}',
      '{"vm_name":"mia-paws-123","error":"secret"}',
      '{"vm_name":"mia-paws-123","ssh_dest":"bad\nvalue"}',
    ]) {
      expect(await errorOf(harness(text).client.createVm(input))).toMatchObject({
        code: "invalid_response",
        outcome: "unknown",
      });
    }
  });

  test("does not retry or leak response/token/transport details for HTTP failures", async () => {
    for (const status of [400, 401, 403, 404, 405, 413, 422, 429, 500, 504]) {
      let count = 0;
      const { client } = harness("", {
        fetch: async () => {
          count++;
          return new Response("exe1.secret quota detail", { status });
        },
      });
      const error = await errorOf(client.createVm(input));
      expect(error).toMatchObject({
        code: "http",
        status,
        outcome: [422, 500, 504].includes(status) ? "unknown" : "rejected",
      });
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(error.message).not.toContain("detail");
      expect(count).toBe(1);
    }
    const error = await errorOf(
      harness("", {
        fetch: async () => {
          throw new Error("Bearer exe1.secret");
        },
      }).client.createVm(input),
    );
    expect(error).toMatchObject({ code: "transport", outcome: "unknown" });
    expect(error.message).not.toContain("secret");
    expect(error.cause).toBeUndefined();
  });

  test("missing/invalid/failing credentials never reach HTTP", async () => {
    for (const token of ["", "exe1.bad\nheader", "has spaces", "a".repeat(8193)]) {
      const { client, calls } = harness("", { readToken: async () => token });
      expect(await errorOf(client.createVm(input))).toMatchObject({
        code: "credentials",
        outcome: "not_sent",
      });
      expect(calls).toHaveLength(0);
    }
    expect(
      await errorOf(
        harness("", {
          readToken: async () => {
            throw new Error("secret path");
          },
        }).client.listVms(),
      ),
    ).toMatchObject({ code: "credentials", outcome: "not_sent" });
  });

  test("bounds stalled credentials and never sends after deadline", async () => {
    let provide!: (token: string) => void;
    const { client, calls } = harness("", {
      timeoutMs: 10,
      readToken: () =>
        new Promise((resolve) => {
          provide = resolve;
        }),
    });
    expect(await errorOf(client.createVm(input))).toMatchObject({
      code: "timeout",
      outcome: "not_sent",
    });
    provide("exe1.fake");
    await Bun.sleep(1);
    expect(calls).toHaveLength(0);
  });

  test("bounds stalled transport and response streams, aborts without retry", async () => {
    let signal: AbortSignal | null | undefined;
    const fetch: ExeDevOptions["fetch"] = async (_, init) => {
      signal = init.signal;
      return new Promise(() => {});
    };
    expect(
      await errorOf(harness("", { timeoutMs: 10, fetch }).client.createVm(input)),
    ).toMatchObject({ code: "timeout", outcome: "unknown" });
    expect(signal?.aborted).toBe(true);
    expect(
      await errorOf(
        harness("", {
          timeoutMs: 10,
          fetch: async () => new Response(new ReadableStream()),
        }).client.execVm({ vmName: input.name, command: "true" }),
      ),
    ).toMatchObject({ code: "timeout", outcome: "unknown" });
  });

  test("bounds JSON/NDJSON bytes and rejects invalid UTF8", async () => {
    for (const body of ["x".repeat(100), '{"stdout":"' + "YWFh".repeat(30) + '"}\n' + terminal]) {
      expect(
        await errorOf(
          harness(body, { maxResponseBytes: 32 }).client.execVm({
            vmName: input.name,
            command: "true",
          }),
        ),
      ).toMatchObject({ code: "output_limit" });
    }
    expect(
      await errorOf(harness("x".repeat(100), { maxResponseBytes: 32 }).client.listVms()),
    ).toMatchObject({ code: "output_limit" });
    expect(
      await errorOf(
        harness("", { fetch: async () => new Response(new Uint8Array([255])) }).client.listVms(),
      ),
    ).toMatchObject({ code: "invalid_response" });
    for (const options of [
      { timeoutMs: 0 },
      { timeoutMs: 30001 },
      { maxResponseBytes: 0 },
      { maxResponseBytes: Infinity },
    ]) {
      expect(() => harness("", options)).toThrow(ProvisioningError);
    }
  });
});

describe("VM execution", () => {
  test("quotes whole remote command across lobby layer and handles chunk/UTF8 boundaries", async () => {
    const stdout = Buffer.from("hello 🐕\n");
    const records = [
      JSON.stringify({ stdout: stdout.subarray(0, 8).toString("base64") }),
      JSON.stringify({ stdout: stdout.subarray(8).toString("base64") }),
      '{"stderr":"b29wcwo="}',
      '{"exit_code":3}',
    ].join("\n");
    const { client, calls } = harness("", {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return chunks(records);
      },
    });
    const command = "printf '%s' \"$HOME\"; echo oops >&2; exit 3";
    expect(await client.execVm({ vmName: input.name, command })).toEqual({
      stdout: "hello 🐕\n",
      stderr: "oops\n",
      exitCode: 3,
    });
    expect(calls[0]?.init.headers).toMatchObject({ Accept: "application/x-ndjson" });
    expect(calls[0]?.init.body).toBe(
      "ssh 'mia-paws-123' 'printf '\\''%s'\\'' \"$HOME\"; echo oops >&2; exit 3'",
    );
    const result = Bun.spawnSync(["bash", "-c", `set -- ${calls[0]?.init.body}; printf '%s' "$3"`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(command);
  });

  test("requires exactly one terminal exit and rejects error, truncation and ambiguous records", async () => {
    const malformed = [
      "",
      '{"stdout":"aGk="}\n',
      '{"error":"secret failure"}\n',
      terminal + terminal,
      terminal + '{"stdout":""}\n',
      '{"exit_code":-1}',
      '{"exit_code":256}',
      '{"exit_code":"0"}',
      '{"stdout":"aGk=","stderr":""}\n' + terminal,
      '{"stdout":"!!!!"}\n' + terminal,
      '{"stdout":"Zh=="}\n' + terminal,
      '{"unknown":""}\n' + terminal,
      '{"stdout":"aGk=',
      "\n" + terminal,
    ];
    for (const text of malformed) {
      const error = await errorOf(
        harness(text).client.execVm({ vmName: input.name, command: "true" }),
      );
      expect(["invalid_response", "incomplete_exec"]).toContain(error.code);
      expect(error.outcome).toBe("unknown");
      expect(error.message).not.toContain("secret");
    }
    expect(await harness(terminal).client.execVm({ vmName: input.name, command: "true" })).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  test("real fetch against only loopback fake HTTP preserves request contract", async () => {
    const seen: { body: string; authorization: string | null; accept: string | null }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seen.push({
          body: await request.text(),
          authorization: request.headers.get("authorization"),
          accept: request.headers.get("accept"),
        });
        return chunks('{"stdout":"bG9jYWwK"}\n' + terminal);
      },
    });
    try {
      const client = createExeDev({
        readToken: async () => "exe1.local-fake",
        fetch: async (url, init) => {
          expect(url).toBe("https://exe.dev/exec");
          return fetch(`http://127.0.0.1:${server.port}/exec`, init);
        },
      });
      expect(await client.execVm({ vmName: input.name, command: "printf local" })).toEqual({
        stdout: "local\n",
        stderr: "",
        exitCode: 0,
      });
      expect(seen).toEqual([
        {
          body: "ssh 'mia-paws-123' 'printf local'",
          authorization: "Bearer exe1.local-fake",
          accept: "application/x-ndjson",
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });
});

describe("fake provider", () => {
  test("records calls, readiness, failed commands and committed response-lost create without idempotent replay", async () => {
    const fake = createFakeExeDev();
    fake.loseNextCreateResponse = true;
    expect(await errorOf(fake.createVm(input))).toMatchObject({
      code: "transport",
      outcome: "unknown",
    });
    expect(await fake.listVms()).toMatchObject([{ name: input.name, status: "starting" }]);
    expect(await errorOf(fake.createVm(input))).toMatchObject({ code: "http", status: 422 });
    expect(fake.vms.size).toBe(1);
    expect(await errorOf(fake.execVm({ vmName: input.name, command: "true" }))).toMatchObject({
      code: "http",
    });
    fake.vms.get(input.name)!.status = "running";
    fake.execResults.push({ stdout: "", stderr: "failed", exitCode: 7 });
    expect(await fake.execVm({ vmName: input.name, command: "false" })).toEqual({
      stdout: "",
      stderr: "failed",
      exitCode: 7,
    });
    fake.execResults.push(new ProvisioningError("exec", "incomplete_exec", "unknown"));
    expect(await errorOf(fake.execVm({ vmName: input.name, command: "true" }))).toMatchObject({
      code: "incomplete_exec",
    });
    expect(await errorOf(fake.execVm({ vmName: input.name, command: "true" }))).toMatchObject({
      code: "incomplete_exec",
    });
    const listed = await fake.listVms();
    listed[0]!.status = "not-real";
    expect(fake.vms.get(input.name)?.status).toBe("running");
    expect(fake.calls[0]).toEqual({ operation: "create", input });
    expect(fake.calls.map((call) => call.operation)).toEqual([
      "create",
      "list",
      "create",
      "exec",
      "exec",
      "exec",
      "exec",
      "list",
    ]);
  });

  test("models explicit auth, permission and provider rejection before creating anything", async () => {
    for (const status of [401, 403, 422, 429]) {
      const fake = createFakeExeDev();
      fake.failures.create = [new ProvisioningError("create", "http", "rejected", status)];
      expect(await errorOf(fake.createVm(input))).toMatchObject({ status });
      expect(fake.vms.size).toBe(0);
      expect(await fake.createVm(input)).toMatchObject({ name: input.name });
    }
  });
});
