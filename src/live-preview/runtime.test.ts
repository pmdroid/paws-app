import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PreviewRequestSchema,
  createFakePreviewRuntime,
  runPreview,
  previewRunnerSupported,
} from "./index";
import { previewEnvironment } from "./runtime";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const request = PreviewRequestSchema.parse({
  command: ["bun", "--no-env-file", "run", "fixtures"],
  port: 3123,
  checklist: ["Create a fixture account"],
});
async function input() {
  const lockNamespace = await mkdtemp(join(tmpdir(), "preview-test-"));
  roots.push(lockNamespace);
  return {
    request,
    worktree: "/fixture/worktree",
    head: "b".repeat(40),
    services: ["paws-preview-1"],
    path: "/fixture/bin:/usr/bin",
    lockNamespace,
    signal: new AbortController().signal,
  };
}

test("isolates the app environment, warms HTTPS before ready, and clears its service", async () => {
  const fake = createFakePreviewRuntime({ warmFailures: 1 });
  let ready = false;
  expect(
    await runPreview({
      ...(await input()),
      runtime: fake.io,
      async ready(preview) {
        ready = true;
        expect(preview.url).toBe("https://paws-preview-1.test-tail.ts.net/");
        expect(preview.frameable).toBe(true);
        expect(fake.calls).toContainEqual([
          "tailscale",
          "serve",
          "--service=svc:paws-preview-1",
          "--https=443",
          "http://127.0.0.1:3123",
        ]);
        expect(fake.stopped).toBe(false);
        return "accepted";
      },
    }),
  ).toBe("accepted");
  expect(ready).toBe(true);
  expect(fake.stopped).toBe(true);
  expect(fake.calls.at(-1)).toEqual(["tailscale", "serve", "clear", "svc:paws-preview-1"]);
  const env = fake.starts[0]!.env;
  expect(env.HOME).toContain("paws-preview-");
  expect(env).toEqual(previewEnvironment(env.HOME!, "/fixture/bin:/usr/bin", 3123));
  expect(Object.keys(env)).not.toContain("GITHUB_TOKEN");
  expect(Object.keys(env)).not.toContain("PAWS_ASK_TEAM_SOCKET");
});

test.each<Record<string, string>>([
  { "content-security-policy": "default-src 'self', frame-ancestors 'none'" },
  { "content-security-policy": "frame-ancestors *, frame-ancestors 'none'" },
  { "x-frame-options": "DENY" },
  { "content-security-policy": "default-src 'self'; frame-ancestors 'self'" },
])("reports frame refusal with %j", async (headers) => {
  const fake = createFakePreviewRuntime({ frameHeaders: headers });
  await runPreview({
    ...(await input()),
    runtime: fake.io,
    async ready(preview) {
      expect(preview.frameable).toBe(false);
      return "accepted";
    },
  });
});

test("expires while a reviewer is absent and stops the product", async () => {
  const fake = createFakePreviewRuntime();
  await expect(
    runPreview({
      ...(await input()),
      runtime: fake.io,
      timeoutMs: 50,
      ready: () => new Promise(() => undefined),
    }),
  ).rejects.toThrow();
  expect(fake.stopped).toBe(true);
  expect(fake.calls.at(-1)).toEqual(["tailscale", "serve", "clear", "svc:paws-preview-1"]);
});

test.each([{ tagged: false }, { occupied: true }, { wildcard: true }])(
  "fails closed before advertising with %j",
  async (options) => {
    const fake = createFakePreviewRuntime(options);
    await expect(
      runPreview({
        ...(await input()),
        runtime: fake.io,
        async ready() {
          throw new Error("must not publish");
        },
      }),
    ).rejects.toThrow();
    expect(fake.calls.some((argv) => argv[1] === "serve" && argv[2] !== "clear")).toBe(false);
  },
);

test("a slot cannot be shared by concurrent previews and is reusable after stop", async () => {
  const config = await input();
  const fake = createFakePreviewRuntime();
  let release: (value: string) => void = () => undefined;
  let becameReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    becameReady = resolve;
  });
  const running = runPreview({
    ...config,
    runtime: fake.io,
    ready: async () => {
      becameReady();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await ready;
  const planted = join(config.lockNamespace, "paws-preview-1");
  await mkdir(planted);
  await writeFile(join(planted, "owner"), "0");
  await rm(planted, { recursive: true });
  await expect(
    runPreview({
      ...config,
      runtime: createFakePreviewRuntime().io,
      async ready() {
        return "";
      },
    }),
  ).rejects.toThrow("No preview service is free");
  release("accepted");
  await running;
  await runPreview({
    ...config,
    runtime: createFakePreviewRuntime().io,
    async ready() {
      return "accepted";
    },
  });
});

test("cancellation stops the app even if the review callback does not observe its signal", async () => {
  const config = await input();
  const controller = new AbortController();
  const fake = createFakePreviewRuntime();
  await expect(
    runPreview({
      ...config,
      signal: controller.signal,
      runtime: fake.io,
      ready: async () => {
        controller.abort(new Error("Item moved on"));
        return new Promise(() => undefined);
      },
    }),
  ).rejects.toThrow("Item moved on");
  expect(fake.stopped).toBe(true);
});

test("a failed Serve clear stops the product and retries cleanup before reusing the slot", async () => {
  const config = await input();
  const fake = createFakePreviewRuntime();
  const command = fake.io.command;
  fake.io.command = async (argv) => {
    if (argv[2] === "clear" && fake.starts.length > 0) throw new Error("Serve clear failed");
    return command(argv);
  };
  expect(await runPreview({ ...config, runtime: fake.io, ready: async () => "accepted" })).toBe(
    "accepted",
  );
  expect(fake.stopped).toBe(true);
  const retry = createFakePreviewRuntime();
  await runPreview({
    ...config,
    runtime: retry.io,
    async ready() {
      return "accepted";
    },
  });
  expect(retry.calls[0]).toEqual(["tailscale", "serve", "clear", "svc:paws-preview-1"]);
});

test.each([
  ["0.1.48", false],
  ["0.1.49", false],
  ["0.1.52", false],
  ["0.1.53", true],
  ["0.1.53-rc.1", true],
  ["0.1.54+build", true],
  ["0.2.0", true],
  [null, false],
  ["invalid", false],
] as const)("preview runner capability for %s is %s", (version, expected) => {
  expect(previewRunnerSupported(version)).toBe(expected);
});

test("unconfirmed process cleanup retains its lease without replacing acceptance", async () => {
  const config = await input();
  const fake = createFakePreviewRuntime();
  const start = fake.io.start;
  fake.io.start = (...args) => ({
    ...start(...args),
    stop: async () => {
      throw new Error("unconfirmed");
    },
  });
  expect(await runPreview({ ...config, runtime: fake.io, ready: async () => "accepted" })).toBe(
    "accepted",
  );
  await expect(
    runPreview({
      ...config,
      runtime: createFakePreviewRuntime().io,
      ready: async () => "accepted",
    }),
  ).rejects.toThrow("No preview service is free");
});

test("a killed worker releases its kernel lease and the next worker clears Serve", async () => {
  const config = await input();
  const module = new URL("./index.ts", import.meta.url).pathname;
  const script = `import {runPreview,createFakePreviewRuntime} from ${JSON.stringify(module)};
    await runPreview({...${JSON.stringify({ ...config, signal: undefined })}, signal:new AbortController().signal,
      runtime:createFakePreviewRuntime().io, ready:async()=>{
        console.log("ready"); setInterval(()=>{},1000); return new Promise(()=>{});
      }});`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    reader.releaseLock();
    await expect(
      runPreview({
        ...config,
        runtime: createFakePreviewRuntime().io,
        ready: async () => "accepted",
      }),
    ).rejects.toThrow("No preview service is free");
    child.kill("SIGKILL");
    await child.exited;
    const next = createFakePreviewRuntime();
    expect(await runPreview({ ...config, runtime: next.io, ready: async () => "accepted" })).toBe(
      "accepted",
    );
    expect(next.calls[0]).toEqual(["tailscale", "serve", "clear", "svc:paws-preview-1"]);
  } finally {
    child.kill();
    await child.exited;
  }
});
