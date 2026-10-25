import { describe, expect, test } from "bun:test";
import {
  createExeDev,
  EXE_DEV_ENDPOINT,
  ProvisioningError,
  type ExeDevFetch,
  type ProvisioningErrorCode,
  type ProvisioningOperation,
} from "../src/provisioning";

const TOKEN = "exe1.fake-test-token";

type Sent = { url: string; init: RequestInit; body: string; headers: Headers };

function client(
  respond: (sent: Sent) => Response | Promise<Response>,
  options: { token?: () => string | null; timeoutMs?: number; maxBytes?: number } = {},
) {
  const sent: Sent[] = [];
  let reads = 0;
  const fetch: ExeDevFetch = async (url, init) => {
    const entry = {
      url,
      init,
      body: String(init.body),
      headers: new Headers(init.headers),
    };
    sent.push(entry);
    return respond(entry);
  };
  const exe = createExeDev({
    fetch,
    readToken: () => {
      reads += 1;
      return options.token ? options.token() : TOKEN;
    },
    ...(options.timeoutMs === undefined
      ? {}
      : {
          timeoutMs: {
            createVm: options.timeoutMs,
            getVm: options.timeoutMs,
            execVm: options.timeoutMs,
          },
        }),
    ...(options.maxBytes === undefined
      ? {}
      : {
          maxResponseBytes: {
            createVm: options.maxBytes,
            getVm: options.maxBytes,
            execVm: options.maxBytes,
          },
        }),
  });
  return { exe, sent, reads: () => reads };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  });
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

const CREATED = {
  vm_name: "ada-paws",
  tags: [],
  ssh_command: "ssh ada-paws.exe.xyz",
  ssh_dest: "ada-paws.exe.xyz",
  ssh_host: "ada-paws.exe.xyz",
  ssh_port: 22,
  https_url: "https://ada-paws.exe.xyz",
};

const LISTED = {
  vms: [
    {
      vm_name: "ada-paws",
      status: "running",
      region: "lon",
      region_display: "London, UK",
      https_url: "https://ada-paws.exe.xyz",
      ssh_dest: "ada-paws.exe.xyz",
      ssh_host: "ada-paws.exe.xyz",
    },
  ],
};

async function failure(promise: Promise<unknown>): Promise<ProvisioningError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    const typed = error as ProvisioningError;
    expect(typed.message).not.toContain(TOKEN);
    return typed;
  }
  throw new Error("expected a ProvisioningError");
}

function expectCode(
  error: ProvisioningError,
  operation: ProvisioningOperation,
  code: ProvisioningErrorCode,
): void {
  expect({ operation: error.operation, code: error.code }).toEqual({ operation, code });
}

describe("createVm", () => {
  test("posts `new --name` with the bearer token and returns the VM", async () => {
    const { exe, sent } = client(() => json(CREATED));
    expect(await exe.createVm("ada-paws")).toEqual({
      name: "ada-paws",
      sshDest: "ada-paws.exe.xyz",
      httpsUrl: "https://ada-paws.exe.xyz",
    });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe(EXE_DEV_ENDPOINT);
    expect(request?.init.method).toBe("POST");
    expect(request?.init.redirect).toBe("error");
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
    expect(request?.body).toBe("new --name=ada-paws");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("rejects invalid VM names before any request", async () => {
    const { exe, sent, reads } = client(() => json(CREATED));
    for (const name of ["", "Ada", "-ada", "ada-", "ada paws", "a;rm -rf /", "a".repeat(64)]) {
      expectCode(await failure(exe.createVm(name)), "createVm", "invalid_name");
    }
    expect(sent).toHaveLength(0);
    expect(reads()).toBe(0);
  });

  test("a response for another VM is invalid", async () => {
    const { exe } = client(() => json({ ...CREATED, vm_name: "other" }));
    expectCode(await failure(exe.createVm("ada-paws")), "createVm", "invalid_response");
  });

  test("malformed bodies are invalid_response and do not leak the body", async () => {
    const bodies = [
      "not json",
      "[]",
      JSON.stringify({ vm_name: "ada-paws" }),
      JSON.stringify({ ...CREATED, https_url: "http://ada-paws.exe.xyz" }),
      JSON.stringify({ ...CREATED, ssh_dest: "ada paws; rm" }),
      JSON.stringify({ error: 42 }),
    ];
    for (const body of bodies) {
      const { exe } = client(() => new Response(body));
      const error = await failure(exe.createVm("ada-paws"));
      expectCode(error, "createVm", "invalid_response");
      expect(error.message).not.toContain(body);
    }
  });

  test("HTTP errors map to codes without the body", async () => {
    const cases: [number, unknown, ProvisioningErrorCode][] = [
      [401, { error: "invalid token" }, "unauthorized"],
      [403, { error: "command not allowed" }, "unauthorized"],
      [409, { error: "busy" }, "conflict"],
      [422, { error: 'VM "ada-paws" already exists' }, "conflict"],
      [404, { error: "unknown command" }, "missing"],
      [422, { error: 'VM "ada-paws" not found' }, "missing"],
      [429, { error: "slow down" }, "rate_limited"],
      [422, { error: "Choose a plan to start creating VMs." }, "unknown"],
      [500, "oops", "unknown"],
      [400, { error: `bad token ${TOKEN}` }, "unknown"],
    ];
    for (const [status, body, code] of cases) {
      const { exe } = client(() => json(body, status));
      const error = await failure(exe.createVm("ada-paws"));
      expectCode(error, "createVm", code);
      expect(error.status).toBe(status);
      expect(error.message).not.toContain("plan");
      expect(error.message).not.toContain("slow down");
    }
  });

  test("a 200 `{error}` body is a refused command", async () => {
    const { exe } = client(() => json({ error: 'VM "ada-paws" already exists' }));
    expectCode(await failure(exe.createVm("ada-paws")), "createVm", "conflict");
  });
});

describe("token", () => {
  test("is read on every request", async () => {
    const { exe, reads } = client(() => json(LISTED));
    await exe.getVm("ada-paws");
    await exe.getVm("ada-paws");
    expect(reads()).toBe(2);
  });

  test("a missing, empty, malformed or unreadable token stops the request", async () => {
    const readers: (() => string | null)[] = [
      () => null,
      () => "  \n",
      () => "exe1.abc\nX-Evil: 1",
      () => {
        throw new Error(`could not decrypt ${TOKEN}`);
      },
    ];
    for (const token of readers) {
      const { exe, sent } = client(() => json(LISTED), { token });
      expectCode(await failure(exe.getVm("ada-paws")), "getVm", "no_token");
      expect(sent).toHaveLength(0);
    }
  });

  test("is trimmed before use", async () => {
    const { exe, sent } = client(() => json(LISTED), { token: () => `${TOKEN}\n` });
    await exe.getVm("ada-paws");
    expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

describe("getVm", () => {
  test("lists the one VM and returns its status", async () => {
    const { exe, sent } = client(() => json(LISTED));
    expect(await exe.getVm("ada-paws")).toEqual({
      name: "ada-paws",
      status: "running",
      region: "lon",
      sshDest: "ada-paws.exe.xyz",
      httpsUrl: "https://ada-paws.exe.xyz",
    });
    expect(sent[0]?.body).toBe("ls ada-paws");
  });

  test("an unlisted VM is missing", async () => {
    const { exe } = client(() => json({ vms: [{ ...LISTED.vms[0], vm_name: "ada-paws2" }] }));
    expectCode(await failure(exe.getVm("ada-paws")), "getVm", "missing");
  });

  test("odd listings are invalid_response", async () => {
    const vm = LISTED.vms[0];
    for (const body of [
      { vms: null },
      { vms: ["ada-paws"] },
      { vms: [{ ...vm, status: 3 }] },
      { vms: [{ ...vm, status: "Running!" }] },
      { vms: [vm, vm] },
    ]) {
      const { exe } = client(() => json(body));
      expectCode(await failure(exe.getVm("ada-paws")), "getVm", "invalid_response");
    }
  });
});

describe("execVm", () => {
  test("quotes the command once and decodes the NDJSON stream", async () => {
    const { exe, sent } = client(() =>
      ndjson([
        { stdout: b64("pairing code ") },
        { stderr: b64("warn\n") },
        { stdout: b64("ABCD-1234\n") },
        { exit_code: 3 },
      ]),
    );
    const result = await exe.execVm("ada-paws", "echo 'hi' && paws-runner runner pair");
    expect(result).toEqual({ exitCode: 3, stdout: "pairing code ABCD-1234\n", stderr: "warn\n" });
    expect(sent[0]?.body).toBe(`ssh ada-paws 'echo '\\''hi'\\'' && paws-runner runner pair'`);
    expect(sent[0]?.headers.get("accept")).toBe("application/x-ndjson");
  });

  test("joins multibyte output split across chunks", async () => {
    const bytes = Buffer.from("grüße\n");
    const { exe } = client(() =>
      ndjson([
        { stdout: bytes.subarray(0, 3).toString("base64") },
        { stdout: bytes.subarray(3).toString("base64") },
        { exit_code: 0 },
      ]),
    );
    expect((await exe.execVm("ada-paws", "cat greeting")).stdout).toBe("grüße\n");
  });

  test("an error line means the VM never reported an exit", async () => {
    const { exe } = client(() => ndjson([{ stdout: b64("half") }, { error: "lost VM" }]));
    const error = await failure(exe.execVm("ada-paws", "true"));
    expectCode(error, "execVm", "unknown");
    expect(error.message).not.toContain("lost VM");
  });

  test("a cut-off or malformed stream is invalid_response", async () => {
    const streams = [
      [{ stdout: b64("partial") }],
      [{ stdout: "not base64!" }, { exit_code: 0 }],
      [{ exit_code: 1.5 }],
      [{ exit_code: 0 }, { stdout: b64("after") }],
      [{ stdout: b64("a"), exit_code: 0 }],
      [{ verdict: "ok" }],
      [{ error: "early" }, { exit_code: 0 }],
    ];
    for (const lines of streams) {
      const { exe } = client(() => ndjson(lines));
      expectCode(await failure(exe.execVm("ada-paws", "true")), "execVm", "invalid_response");
    }
    const { exe } = client(() => new Response("{not json}\n"));
    expectCode(await failure(exe.execVm("ada-paws", "true")), "execVm", "invalid_response");
  });

  test("empty or NUL commands never leave Paws", async () => {
    const { exe, sent } = client(() => ndjson([{ exit_code: 0 }]));
    for (const command of ["", "   ", "echo\0hi", "x".repeat(64 * 1024 + 1)]) {
      expectCode(await failure(exe.execVm("ada-paws", command)), "execVm", "invalid_command");
    }
    expectCode(await failure(exe.execVm("ADA", "true")), "execVm", "invalid_name");
    expect(sent).toHaveLength(0);
  });
});

describe("bounds", () => {
  test("a declared oversized body is invalid_response", async () => {
    const { exe } = client(
      () =>
        new Response(JSON.stringify(CREATED), {
          headers: { "content-length": String(1024 * 1024) },
        }),
      { maxBytes: 1024 },
    );
    expectCode(await failure(exe.createVm("ada-paws")), "createVm", "invalid_response");
  });

  test("a streamed body past the limit is cut off as invalid_response", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode(`{"stdout":"${b64("x".repeat(300))}"}\n`));
      },
    });
    const { exe } = client(() => new Response(stream), { maxBytes: 2048 });
    expectCode(await failure(exe.execVm("ada-paws", "yes")), "execVm", "invalid_response");
    expect(pulled).toBeLessThan(20);
  });

  test("a request that never answers times out", async () => {
    const { exe } = client(
      (sent) =>
        new Promise<Response>((_, reject) => {
          sent.init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      { timeoutMs: 20 },
    );
    expectCode(await failure(exe.getVm("ada-paws")), "getVm", "timeout");
  });

  test("a fetch that ignores the signal still times out", async () => {
    const { exe } = client(() => new Promise<Response>(() => {}), { timeoutMs: 20 });
    expectCode(await failure(exe.createVm("ada-paws")), "createVm", "timeout");
  });

  test("a body that never ends times out", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"stdout":"${b64("hi")}"}\n`));
      },
    });
    const { exe } = client(() => new Response(stream), { timeoutMs: 20 });
    expectCode(await failure(exe.execVm("ada-paws", "sleep 999")), "execVm", "timeout");
  });

  test("a per-call exec timeout cannot exceed the client's maximum", async () => {
    const { exe } = client(() => new Promise<Response>(() => {}), { timeoutMs: 20 });
    const started = Date.now();
    expectCode(
      await failure(exe.execVm("ada-paws", "true", { timeoutMs: 60_000 })),
      "execVm",
      "timeout",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a network failure is unknown and says nothing about the cause", async () => {
    const { exe } = client(() => {
      throw new Error(`connect failed with ${TOKEN}`);
    });
    const error = await failure(exe.getVm("ada-paws"));
    expectCode(error, "getVm", "unknown");
    expect(error.message).not.toContain("connect failed");
  });
});
