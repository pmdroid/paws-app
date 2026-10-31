import { OwnedProcess } from "../process";
import { createServer } from "node:net";
import { journalCaught } from "../journal";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  PreviewRequestSchema,
  PreviewReadySchema,
  type PreviewRequest,
  type PreviewReady,
} from "../runner-protocol";

export interface PreviewProcess {
  stop(): Promise<void>;
  exited: Promise<number>;
}
export interface PreviewRuntime {
  command(argv: string[]): Promise<string>;
  start(argv: string[], cwd: string, env: Record<string, string>): PreviewProcess;
  fetch(url: string, signal: AbortSignal): Promise<Response>;
}
const runtime: PreviewRuntime = {
  async command(argv) {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 15000);
    const output = await new Response(child.stdout).text();
    clearTimeout(timer);
    if ((await child.exited) !== 0)
      throw new Error(
        argv[0] === "ss"
          ? "Preview port probe failed. Install iproute2 and check ss permissions."
          : "Tailscale preview command failed. Check services, runner tags and operator permission.",
      );
    return output;
  },
  start(argv, cwd, env) {
    const child = new OwnedProcess(argv[0]!, argv.slice(1), env, cwd);
    child.stdout?.resume();
    child.stderr?.resume();
    const exited = new Promise<number>((resolve, reject) => {
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", reject);
    });
    return {
      exited,
      async stop() {
        if (!(await child.stop(2000))) throw new Error("Preview process cleanup is unconfirmed");
      },
    };
  },
  fetch: (url, signal) => fetch(url, { signal, redirect: "manual" }),
};

/** Environment allowlist: neither Paws secrets nor the agent's login/config are inherited. */
export function previewEnvironment(
  home: string,
  path: string,
  port: number,
): Record<string, string> {
  return {
    HOME: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    PATH: path,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    PAWS_PREVIEW_FIXTURES: "1",
  };
}

/** Kernel ownership cannot be rewritten through an agent's writable home. Linux
 * releases abstract sockets when the worker exits, including after SIGKILL. */
async function claimService(
  namespace: string,
  name: string,
): Promise<(() => Promise<void>) | null> {
  const address =
    "\0paws-preview-" +
    createHash("sha256").update(`${namespace}:${name}`).digest("hex").slice(0, 48);
  const lock = createServer((socket) => socket.destroy());
  lock.unref();
  const claimed = await new Promise<boolean>((resolve, reject) => {
    lock.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    lock.listen(address, () => resolve(true));
  });
  if (!claimed) return null;
  return () =>
    new Promise<void>((resolve, reject) => {
      lock.close((error) => (error ? reject(error) : resolve()));
    });
}

/** Own the service and process until the review, cancellation, or the one-hour limit. */
export async function runPreview(input: {
  request: PreviewRequest;
  worktree: string;
  head: string;
  services: readonly string[];
  path: string;
  lockNamespace: string;
  signal: AbortSignal;
  ready(preview: PreviewReady, signal: AbortSignal): Promise<string>;
  stopped?(id: string): void;
  runtime?: PreviewRuntime;
  timeoutMs?: number;
  startupTimeouts?: { appMs: number; warmupMs: number };
}): Promise<string> {
  const request = PreviewRequestSchema.parse(input.request);
  const io = input.runtime ?? runtime;
  const timeoutMs = Math.min(input.timeoutMs ?? 3600000, 3600000);
  const expiresAt = Date.now() + timeoutMs;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
  let releaseService: (() => Promise<void>) | null = null;
  let service: string | undefined;
  for (const name of input.services) {
    if (!/^paws-preview-[1-9][0-9]*$/.test(name))
      throw new Error("Invalid preview service configuration");
    releaseService = await claimService(input.lockNamespace, name);
    if (releaseService) {
      service = name;
      break;
    }
  }
  if (!service)
    throw new Error(
      "No preview service is free on this runner. Assign one distinct service per runner slot in /etc/paws/preview-services.json.",
    );
  let home: string | undefined;
  let child: PreviewProcess | undefined;
  let serving = false;
  let published: PreviewReady | undefined;
  let startup: AbortSignal | undefined;
  let startupStage = "App startup";
  try {
    signal.throwIfAborted();
    // A dead worker can leave Serve configured. Clear only after owning its name.
    await io.command(["tailscale", "serve", "clear", `svc:${service}`]);
    const status = JSON.parse(await io.command(["tailscale", "status", "--json"])) as {
      CurrentTailnet?: { MagicDNSSuffix?: string };
      Self?: { Tags?: string[] };
    };
    const suffix = status.CurrentTailnet?.MagicDNSSuffix;
    if (
      !suffix ||
      !/^[a-z0-9-]+\.ts\.net$/.test(suffix) ||
      !status.Self?.Tags?.includes("tag:paws-runner")
    )
      throw new Error("Previews need a tagged Tailscale runner and MagicDNS.");
    const local = `http://127.0.0.1:${request.port}${request.startPath}`;
    // Check TCP listeners, including servers that do not speak HTTP.
    const socketQuery = ["ss", "-H", "-ltn", "sport", "=", `:${request.port}`];
    if ((await io.command(socketQuery)).trim())
      throw new Error("Preview port is already in use. Choose a free port.");
    home = await mkdtemp(join(tmpdir(), "paws-preview-"));
    child = io.start(
      request.command,
      input.worktree,
      previewEnvironment(home, input.path, request.port),
    );
    let exited = false;
    void child.exited.then(
      () => {
        exited = true;
      },
      () => {
        exited = true;
      },
    );
    startup = AbortSignal.any([signal, AbortSignal.timeout(input.startupTimeouts?.appMs ?? 60000)]);
    let response: Response;
    for (;;) {
      startup.throwIfAborted();
      if (exited) throw new Error("Preview command exited before its port answered.");
      try {
        response = await io.fetch(local, AbortSignal.any([startup, AbortSignal.timeout(1500)]));
        break;
      } catch {
        await delay(200, undefined, { signal: startup });
      }
    }
    const listeners = await io.command(socketQuery);
    if (
      !listeners.trim() ||
      listeners
        .trim()
        .split("\n")
        .some(
          (line) =>
            ![`127.0.0.1:${request.port}`, `[::1]:${request.port}`].includes(
              line.trim().split(/\s+/)[3] ?? "",
            ),
        )
    )
      throw new Error("Preview must listen only on loopback. Bind the app to 127.0.0.1.");
    serving = true; // Clear even if advertising partly succeeds then fails.
    await io.command([
      "tailscale",
      "serve",
      `--service=svc:${service}`,
      "--https=443",
      `http://127.0.0.1:${request.port}`,
    ]);
    const url = `https://${service}.${suffix}${request.startPath}`;
    // Certificate issuance gets its own budget after app startup and Serve finish.
    startupStage = "Tailscale HTTPS certificate warm-up";
    startup = AbortSignal.any([
      signal,
      AbortSignal.timeout(input.startupTimeouts?.warmupMs ?? 120000),
    ]);
    // Warm up the service certificate before publishing the URL.
    for (;;) {
      startup.throwIfAborted();
      if (exited) throw new Error("Preview command exited during startup.");
      try {
        const warmed = await io.fetch(url, AbortSignal.any([startup, AbortSignal.timeout(5000)]));
        if (warmed.status >= 500) throw new Error("Service is not ready");
        response = warmed;
        break;
      } catch {
        await delay(300, undefined, { signal: startup });
      }
    }
    // Inspect the final same-origin response. Framing policy can live on a login redirect.
    let frameUrl = url;
    let redirectedOutside = false;
    for (let redirect = 0; response.status >= 300 && response.status < 400; redirect++) {
      const location = response.headers.get("location");
      if (!location || redirect >= 8) {
        redirectedOutside = true;
        break;
      }
      const target = new URL(location, frameUrl);
      if (target.origin !== new URL(url).origin) {
        redirectedOutside = true;
        break;
      }
      frameUrl = target.href;
      response = await io.fetch(frameUrl, AbortSignal.any([startup, AbortSignal.timeout(5000)]));
    }
    const xfo = response.headers.get("x-frame-options");
    const ancestors = [
      ...(response.headers.get("content-security-policy") ?? "").matchAll(
        /(?:^|[;,])\s*frame-ancestors\s+([^;,]+)/gi,
      ),
    ].map((match) => match[1]!.trim());
    const frameable = !redirectedOutside && !xfo && ancestors.every((value) => value === "*");
    const preview = PreviewReadySchema.parse({
      ...request,
      id: randomUUID(),
      head: input.head,
      url,
      expiresAt,
      remainingMs: Math.max(1, expiresAt - Date.now()),
      frameable,
    });
    published = preview;
    const died = child.exited.then(() => {
      throw new Error("Preview command exited during review. Start a new preview.");
    });
    const expired = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    });
    return await Promise.race([input.ready(preview, signal), died, expired]);
  } catch (error) {
    if (!signal.aborted && startup?.aborted && !published)
      throw new Error(
        `${startupStage} timed out. ${startupStage === "App startup" ? "Check the fixture command and loopback port." : "Check Tailscale service approval, DNS and certificate issuance."}`,
        { cause: error },
      );
    throw error;
  } finally {
    try {
      if (published) input.stopped?.(published.id);
    } catch (error) {
      journalCaught(error, "live-preview.stopped", null);
    }
    try {
      if (serving) await io.command(["tailscale", "serve", "clear", `svc:${service}`]);
    } catch (error) {
      journalCaught(error, "live-preview.clear", null);
    }
    let stopped = false;
    try {
      await child?.stop();
      stopped = true;
    } catch (error) {
      journalCaught(error, "live-preview.stop", null);
    }
    // An unconfirmed process keeps its service lease until this worker exits.
    if (stopped) {
      try {
        if (home) await rm(home, { recursive: true, force: true });
      } catch (error) {
        journalCaught(error, "live-preview.remove-home", null);
      }
      try {
        await releaseService?.();
      } catch (error) {
        journalCaught(error, "live-preview.release", null);
      }
    }
  }
}
