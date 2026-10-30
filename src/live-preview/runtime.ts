import { OwnedProcess } from "../process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, readFile, writeFile, lstat } from "node:fs/promises";
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
        "Tailscale preview command failed. Check services, runner tags and operator permission.",
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

/** Never trust a pre-existing shared directory or follow a planted lock symlink. */
async function assertPrivateDirectory(folder: string): Promise<void> {
  const info = await lstat(folder);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Preview locks need a runner-owned directory with mode 0700");
}

async function staleLock(folder: string): Promise<boolean> {
  try {
    const owner = Number(await readFile(join(folder, "owner"), "utf8"));
    if (owner === 0) return true;
    if (!Number.isSafeInteger(owner) || owner < 0) return false;
    try {
      process.kill(owner, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      return Date.now() - (await lstat(folder)).mtimeMs > 60000;
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw missing;
    }
  }
}

async function claimService(root: string, name: string, io: PreviewRuntime): Promise<boolean> {
  const folder = join(root, name);
  const claim = async () => {
    try {
      await mkdir(folder, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    await writeFile(join(folder, "owner"), String(process.pid), { mode: 0o600 });
    return true;
  };
  if (await claim()) return true;
  try {
    await assertPrivateDirectory(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return await claim();
    throw error;
  }
  if (!(await staleLock(folder))) return false;
  const recovery = `${folder}.recovery`;
  try {
    await mkdir(recovery, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertPrivateDirectory(recovery);
    if (!(await staleLock(recovery))) return false;
    await rm(recovery, { recursive: true, force: true });
    try {
      await mkdir(recovery, { mode: 0o700 });
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw retryError;
    }
  }
  await writeFile(join(recovery, "owner"), String(process.pid), { mode: 0o600 });
  try {
    if (!(await staleLock(folder))) return false;
    // A worker may have died before clearing Serve. Clear before recycling its name.
    await io.command(["tailscale", "serve", "clear", `svc:${name}`]);
    await rm(folder, { recursive: true, force: true });
    return await claim();
  } finally {
    await rm(recovery, { recursive: true, force: true });
  }
}

/** Own the service and process until the review, cancellation, or the one-hour limit. */
export async function runPreview(input: {
  request: PreviewRequest;
  worktree: string;
  head: string;
  services: readonly string[];
  path: string;
  lockRoot: string;
  signal: AbortSignal;
  ready(preview: PreviewReady, signal: AbortSignal): Promise<string>;
  stopped?(id: string): void;
  runtime?: PreviewRuntime;
  timeoutMs?: number;
}): Promise<string> {
  const request = PreviewRequestSchema.parse(input.request);
  const io = input.runtime ?? runtime;
  const timeoutMs = Math.min(input.timeoutMs ?? 3600000, 3600000);
  const expiresAt = Date.now() + timeoutMs;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
  await mkdir(input.lockRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(input.lockRoot);
  let service: string | undefined;
  for (const name of input.services) {
    if (!/^paws-preview-[1-9][0-9]*$/.test(name))
      throw new Error("Invalid preview service configuration");
    if (await claimService(input.lockRoot, name, io)) {
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
  try {
    signal.throwIfAborted();
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
    const startup = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
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
  } finally {
    if (published) input.stopped?.(published.id);
    let cleared = !serving;
    try {
      if (serving) await io.command(["tailscale", "serve", "clear", `svc:${service}`]);
      cleared = true;
    } finally {
      let stopped = false;
      try {
        await child?.stop();
        stopped = true;
      } finally {
        if (cleared && stopped) {
          if (home) await rm(home, { recursive: true, force: true });
          await rm(join(input.lockRoot, service), { recursive: true, force: true });
        } else {
          // Retry cleanup on the next claim even if this worker remains alive.
          await writeFile(join(input.lockRoot, service, "owner"), "0", { mode: 0o600 });
        }
      }
    }
  }
}
