import { describe, expect, test } from "bun:test";
import { setJournalSink } from "../src/journal";
import {
  createExeDev,
  DEFAULT_TIMEOUT_MS,
  EXE_DEV_ENDPOINT,
  EXE_DEV_EXEC_LIMIT_MS,
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

  test("sends the configured size as `new` flags", async () => {
    const { exe, sent } = client(() => json(CREATED));
    await exe.createVm("ada-paws", { cpu: 8, memoryGb: 16, diskGb: 100, image: "ubuntu:24.04" });
    await exe.createVm("ada-paws", { memoryGb: 8 });
    await exe.createVm("ada-paws", {});
    expect(sent.map((request) => request.body)).toEqual([
      "new --name=ada-paws --cpu=8 --disk=100GB --image=ubuntu:24.04 --memory=16GB",
      "new --name=ada-paws --memory=8GB",
      "new --name=ada-paws",
    ]);
  });

  test("a size exe.dev refuses fails with exe.dev's message", async () => {
    for (const [status, body] of [
      [422, { error: "cpu 64 exceeds your plan limit of 16" }],
      [200, { error: "cpu 64 exceeds your plan limit of 16" }],
    ] as const) {
      const { exe } = client(() => json(body, status));
      const error = await failure(exe.createVm("ada-paws", { cpu: 64 }));
      expectCode(error, "createVm", "unknown");
      expect(error.message).toBe(
        "exe.dev refused Create VM for ada-paws with --cpu=64: cpu 64 exceeds your plan limit of 16. Change [member_vm] in config.toml.",
      );
    }
    const { exe } = client(() => json({ error: `bad size for ${TOKEN}` }, 400));
    expect((await failure(exe.createVm("ada-paws", { diskGb: 5 }))).message).toContain(
      "bad size for [redacted]",
    );
  });

  test("a pool becomes --pool on `new`, and exe.dev's refusal names it", async () => {
    const { exe, sent } = client(() => json(CREATED));
    await exe.createVm("ada-paws", { cpu: 4, pool: "build" });
    await exe.createVm("ada-paws", { pool: "build" });
    expect(sent.map((request) => request.body)).toEqual([
      "new --name=ada-paws --cpu=4 --pool=build",
      "new --name=ada-paws --pool=build",
    ]);
    for (const [status, said] of [
      [422, 'pool "gpu" not found'],
      [200, "pool gpu is pending approval"],
      [400, "vm needs 8 cpus but pool gpu has 4 free"],
    ] as const) {
      const refused = client(() => json({ error: said }, status));
      const error = await failure(refused.exe.createVm("ada-paws", { pool: "gpu" }));
      expect(error.message).toBe(
        `exe.dev refused Create VM for ada-paws with --pool=gpu: ${said}. Change [member_vm] in config.toml or choose another pool.`,
      );
    }
  });

  test("an invalid size fails before any request", async () => {
    const { exe, sent } = client(() => json(CREATED));
    for (const size of [
      { cpu: 0 },
      { memoryGb: -1 },
      { diskGb: 2.5 },
      { image: "x --cpu=99" },
      { pool: "build --cpu=99" },
      { pool: "" },
    ])
      expectCode(await failure(exe.createVm("ada-paws", size)), "createVm", "invalid_command");
    expect(sent).toHaveLength(0);
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
      [422, { error: 'VM name "ada-paws" is not available' }, "name_unavailable"],
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

  test("a name exe.dev holds for someone else is not blamed on the size or pool", async () => {
    const { exe } = client(() => json({ error: 'VM name "ada-paws" is not available' }, 422));
    const error = await failure(exe.createVm("ada-paws", { cpu: 8, pool: "build" }));
    expectCode(error, "createVm", "name_unavailable");
    expect(error.message).not.toContain("[member_vm]");
  });

  test("a 200 `{error}` body is a refused command", async () => {
    const { exe } = client(() => json({ error: 'VM "ada-paws" already exists' }));
    expectCode(await failure(exe.createVm("ada-paws")), "createVm", "conflict");
  });
});

describe("pools", () => {
  test("`pool list` returns each pool's name, region and status", async () => {
    const { exe, sent } = client(() =>
      json({
        pools: [
          { name: "build", region: "lon", status: "active", vcpu: 16, memory_gb: 64 },
          { pool_name: "gpu", region: "nyc", status: "pending" },
          { name: "spare" },
        ],
      }),
    );
    expect(await exe.listPools()).toEqual([
      { name: "build", region: "lon", status: "active" },
      { name: "gpu", region: "nyc", status: "pending" },
      { name: "spare", region: null, status: null },
    ]);
    expect(sent[0]?.body).toBe("pool list");
    expect(DEFAULT_TIMEOUT_MS.listPools).toBeLessThan(EXE_DEV_EXEC_LIMIT_MS);
    const bare = client(() => json([{ name: "build" }]));
    expect(await bare.exe.listPools()).toEqual([{ name: "build", region: null, status: null }]);
  });

  test("an odd `pool list` is invalid_response", async () => {
    for (const body of [{}, { pools: [{}] }, { pools: [{ name: "a b" }] }, { pools: "x" }]) {
      const { exe } = client(() => json(body));
      expectCode(await failure(exe.listPools()), "listPools", "invalid_response");
    }
  });

  test("`pool adopt` moves a VM and shows exe.dev's refusal in its words", async () => {
    const { exe, sent } = client(() => new Response("", { status: 200 }));
    await exe.adoptVm("ada-paws", "build");
    expect(sent[0]?.body).toBe("pool adopt --vm=ada-paws --pool=build");
    expect(DEFAULT_TIMEOUT_MS.adoptVm).toBeLessThanOrEqual(EXE_DEV_EXEC_LIMIT_MS + 10_000);

    const denied = client(() => json({ error: "only team admins can adopt VMs" }, 403));
    const error = await failure(denied.exe.adoptVm("ada-paws", "build"));
    expectCode(error, "adoptVm", "unauthorized");
    expect(error.message).toBe(
      "exe.dev refused moving ada-paws to pool build: only team admins can adopt VMs.",
    );

    const slow = client(() => new Response("", { status: 504 }));
    expect((await failure(slow.exe.adoptVm("ada-paws", "build"))).message).toContain(
      "the move can take several minutes, so it may still be running",
    );
    const invalid = client(() => json({}));
    expectCode(await failure(invalid.exe.adoptVm("ada-paws", "x y")), "adoptVm", "invalid_command");
    expect(invalid.sent).toHaveLength(0);
  });
});

describe("deleteVm", () => {
  test("posts `rm <vm>` with the bearer token and answers deleted", async () => {
    for (const body of ["", JSON.stringify({ vm_name: "ada-paws", deleted: true })]) {
      const { exe, sent } = client(() => new Response(body));
      expect(await exe.deleteVm("ada-paws")).toBe("deleted");
      expect(sent[0]?.body).toBe("rm ada-paws");
      expect(sent[0]?.init.redirect).toBe("error");
      expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("a VM exe.dev does not know answers missing instead of failing", async () => {
    for (const [status, body] of [
      [404, { error: "not found" }],
      [410, "gone"],
      [422, { error: 'VM "ada-paws" not found' }],
      [200, { error: "no such vm: ada-paws" }],
    ] as const) {
      const { exe } = client(() => json(body, status));
      expect(await exe.deleteVm("ada-paws")).toBe("missing");
    }
  });

  test("an unreadable answer to rm is settled by listing the VM", async () => {
    for (const [listed, result] of [
      [{ vms: [] }, "missing"],
      [{ error: "not found" }, "missing"],
    ] as const) {
      const { exe, sent } = client(({ body }) =>
        body.startsWith("ls ") ? json(listed) : new Response("VM ada-paws not found\n"),
      );
      expect(await exe.deleteVm("ada-paws")).toBe(result);
      expect(sent.map((entry) => entry.body)).toEqual(["rm ada-paws", "ls ada-paws"]);
    }
  });

  test("names, tokens and other errors are checked like the other calls", async () => {
    const { exe, sent } = client(() => new Response(""));
    expectCode(await failure(exe.deleteVm("a;rm -rf /")), "deleteVm", "invalid_name");
    expect(sent).toHaveLength(0);
    for (const [status, code] of [
      [403, "unauthorized"],
      [429, "rate_limited"],
      [500, "unknown"],
    ] as const) {
      const { exe: failing } = client(() => json({ error: "nope" }, status));
      expectCode(await failure(failing.deleteVm("ada-paws")), "deleteVm", code);
    }
    const { exe: odd } = client(({ body }) =>
      body.startsWith("ls ") ? json(LISTED) : new Response("not json"),
    );
    expectCode(await failure(odd.deleteVm("ada-paws")), "deleteVm", "invalid_response");
    const { exe: tokenless } = client(() => new Response(""), { token: () => null });
    expectCode(await failure(tokenless.deleteVm("ada-paws")), "deleteVm", "no_token");
  });

  test("a delete that never answers times out", async () => {
    const exe = createExeDev({
      readToken: () => TOKEN,
      fetch: () => new Promise(() => {}),
      timeoutMs: { deleteVm: 20 },
    });
    expectCode(await failure(exe.deleteVm("ada-paws")), "deleteVm", "timeout");
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
        { stdout: b64("fixture output ") },
        { stderr: b64("warn\n") },
        { stdout: b64("ABCD-1234\n") },
        { exit_code: 3 },
      ]),
    );
    const result = await exe.execVm("ada-paws", "echo 'hi' && paws-runner runner daemon");
    expect(result).toEqual({
      exitCode: 3,
      stdout: "fixture output ABCD-1234\n",
      stderr: "warn\n",
    });
    expect(sent[0]?.body).toBe(`ssh ada-paws 'echo '\\''hi'\\'' && paws-runner runner daemon'`);
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

  test("each unexpected stream says what was wrong and journals only its shape", async () => {
    const secret = b64("SECRET-OUTPUT-0123456789");
    const cases: [Response, RegExp, RegExp][] = [
      [
        ndjson([{ stdout: secret }, { stderr: secret }]),
        /cut off before the exit status, after 2 lines/,
        /status=200 content_type=application\/x-ndjson lines=2 shape=\[stdout\] \[stderr\]$/,
      ],
      [
        new Response(
          `{"stdout":"${secret}"}\n<html>Bad Gateway tok_ABCDEFGHIJKLMNOPQRSTUV</html>\n`,
          {
            headers: { "content-type": "text/html" },
          },
        ),
        /line 2 of 2 is not JSON/,
        /content_type=text\/html lines=2 shape=\[stdout\] \[text length=51 head="<html>Bad Gateway \[redacted\]<\/html>"\]$/,
      ],
      [
        ndjson([{ stdout: secret, exit_code: 0 }]),
        /line 1 of 1 has 2 keys \(stdout, exit_code\) instead of one/,
        /lines=1 shape=\[stdout, exit_code\]$/,
      ],
    ];
    for (const [response, message, shape] of cases) {
      const lines: string[] = [];
      const restore = setJournalSink((line) => lines.push(line));
      try {
        const { exe } = client(() => response);
        const error = await failure(exe.execVm("ada-paws", "true"));
        expectCode(error, "execVm", "invalid_response");
        expect(error.message).toMatch(message);
      } finally {
        restore();
      }
      const journaled = lines.filter((line) => line.startsWith("exe.dev execVm unexpected"));
      expect(journaled).toHaveLength(1);
      expect(journaled[0]).toMatch(shape);
      expect(journaled[0]).toContain("vm=ada-paws");
      for (const line of lines) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain("SECRET-OUTPUT");
        expect(line).not.toContain("tok_ABCDEFGHIJ");
        expect(line).not.toContain(TOKEN);
      }
    }
  });

  test("a 504 is exe.dev's 30 s limit, not a malformed response", async () => {
    const { exe } = client(() => new Response("upstream timed out", { status: 504 }));
    const error = await failure(exe.execVm("ada-paws", "sleep 60"));
    expectCode(error, "execVm", "timeout");
    expect(error.status).toBe(504);
    expect(error.message).toContain("still running on the VM or timed out");
    expect(error.message).not.toContain("upstream");
  });

  test("a 422 is a command that ran and exited non-zero", async () => {
    const { exe } = client(
      () =>
        new Response(
          [{ stderr: b64("nope\n") }, { exit_code: 2 }].map((l) => JSON.stringify(l)).join("\n"),
          { status: 422, headers: { "content-type": "application/x-ndjson" } },
        ),
    );
    expect(await exe.execVm("ada-paws", "false")).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "nope\n",
    });
  });

  test("the default exec timeout waits just past exe.dev's limit", () => {
    expect(DEFAULT_TIMEOUT_MS.execVm).toBeGreaterThan(EXE_DEV_EXEC_LIMIT_MS);
    expect(DEFAULT_TIMEOUT_MS.execVm).toBeLessThanOrEqual(EXE_DEV_EXEC_LIMIT_MS + 10_000);
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
