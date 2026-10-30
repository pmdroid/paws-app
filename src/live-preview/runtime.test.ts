import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, chmod, symlink } from "node:fs/promises";
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
  const lockRoot = await mkdtemp(join(tmpdir(), "preview-test-"));
  roots.push(lockRoot);
  return {
    request,
    worktree: "/fixture/worktree",
    head: "b".repeat(40),
    services: ["paws-preview-1"],
    path: "/fixture/bin:/usr/bin",
    lockRoot,
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
    expect(fake.calls.some((argv) => argv[1] === "serve")).toBe(false);
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

test.each([false, true])(
  "reclaims a dead worker slot with abandoned recovery=%s",
  async (abandonedRecovery) => {
    const config = await input();
    const folder = join(config.lockRoot, "paws-preview-1");
    await mkdir(folder);
    await writeFile(join(folder, "owner"), "2147483647");
    if (abandonedRecovery) {
      await mkdir(`${folder}.recovery`);
      await writeFile(join(`${folder}.recovery`, "owner"), "2147483647");
    }
    const fake = createFakePreviewRuntime();
    await runPreview({
      ...config,
      runtime: fake.io,
      async ready() {
        return "accepted";
      },
    });
    expect(fake.calls[0]).toEqual(["tailscale", "serve", "clear", "svc:paws-preview-1"]);
  },
);

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
    if (argv[2] === "clear") throw new Error("Serve clear failed");
    return command(argv);
  };
  await expect(
    runPreview({
      ...config,
      runtime: fake.io,
      async ready() {
        return "accepted";
      },
    }),
  ).rejects.toThrow("Serve clear failed");
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

test("refuses a shared or symlinked lock root before touching Tailscale", async () => {
  const config = await input();
  const fake = createFakePreviewRuntime();
  await chmod(config.lockRoot, 0o777);
  await expect(
    runPreview({ ...config, runtime: fake.io, ready: async () => "accepted" }),
  ).rejects.toThrow("mode 0700");
  expect(fake.calls).toHaveLength(0);
  await chmod(config.lockRoot, 0o700);
  const link = join(config.lockRoot, "link");
  await symlink(config.lockRoot, link);
  await expect(
    runPreview({ ...config, lockRoot: link, runtime: fake.io, ready: async () => "accepted" }),
  ).rejects.toThrow("mode 0700");
  expect(fake.calls).toHaveLength(0);
});

test("refuses a planted service lock symlink", async () => {
  const config = await input();
  const fake = createFakePreviewRuntime();
  await symlink(config.lockRoot, join(config.lockRoot, "paws-preview-1"));
  await expect(
    runPreview({ ...config, runtime: fake.io, ready: async () => "accepted" }),
  ).rejects.toThrow("mode 0700");
  expect(fake.calls).toHaveLength(0);
});
