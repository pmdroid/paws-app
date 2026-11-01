import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalCaught } from "../journal";
import {
  LIVE_PREVIEW_TIME_LIMIT_MINUTES,
  livePreviewSecretName,
  type LivePreviewStopReason,
  type RunnerLivePreview,
  type RunnerPreviewEvent,
} from "../runner-protocol";

export interface PreviewProcess {
  pid: number;
  exited: Promise<void>;
  kill(): void;
}

export interface LivePreviewSystem {
  spawn(command: string, options: { cwd: string; env: Record<string, string> }): PreviewProcess;
  answers(port: number): Promise<boolean>;
  listeners(port: number, candidates: ReadonlySet<number>): Promise<(number | null)[]>;
  tree(pid: number): Promise<ReadonlySet<number>>;
  claimSlot(): Promise<{ slot: number; release(): void } | null>;
  tailscale(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  warm(url: string, signal: AbortSignal): Promise<boolean>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

export interface LivePreview {
  service: string;
  url: string;
  stop(reason: LivePreviewStopReason): Promise<void>;
  stopped: Promise<LivePreviewStopReason>;
}

export function livePreviewEnv(
  preview: RunnerLivePreview,
  path: string,
  home: string,
): Record<string, string> {
  const fixtures = Object.entries(preview.fixtures ?? {}).filter(
    ([name]) => !livePreviewSecretName(name),
  );
  return {
    ...Object.fromEntries(fixtures),
    PATH: path,
    HOME: home,
    LANG: "C.UTF-8",
    HOST: "127.0.0.1",
    PORT: String(preview.port),
  };
}

class PreviewFailure extends Error {}
class PreviewCancelled extends Error {}

export async function startLivePreview(input: {
  preview: RunnerLivePreview;
  runner: string;
  worktree: string;
  signal?: AbortSignal;
  path: string;
  system: LivePreviewSystem;
  emit(event: RunnerPreviewEvent): void;
  readyTimeoutMs?: number;
  pollMs?: number;
  timeLimitMs?: number;
}): Promise<LivePreview | null> {
  const { preview, system, emit } = input;
  const readyTimeoutMs = input.readyTimeoutMs ?? 120_000;
  const pollMs = input.pollMs ?? 500;
  const signal = input.signal ?? new AbortController().signal;
  const namespace = input.runner.toLowerCase();
  const refuse = (message: string) => {
    emit({ type: "preview", state: "stopped", reason: "failed", message });
    return null;
  };
  if (!/^[a-z0-9]{1,40}$/.test(namespace))
    return refuse("The runner ID can't name a tailnet service.");
  if (signal.aborted) return null;
  const claim = await system.claimSlot();
  if (!claim) return refuse("Every preview service on this runner is in use.");
  const service = `paws-preview-${namespace}-${claim.slot}`;
  const home = mkdtempSync(join(tmpdir(), "paws-preview-"));
  let child: PreviewProcess | undefined;
  let served = false;
  const teardown = async () => {
    child?.kill();
    if (served)
      await system
        .tailscale(["serve", "clear", `svc:${service}`])
        .catch((error: unknown) => journalCaught(error, "live-preview.teardown.clear", null));
    rmSync(home, { recursive: true, force: true });
    claim.release();
  };
  emit({ type: "preview", state: "starting", service });
  let url: string;
  try {
    const started = system.spawn(preview.command, {
      cwd: input.worktree,
      env: livePreviewEnv(preview, input.path, home),
    });
    child = started;
    let exited = false;
    void started.exited.then(() => (exited = true));
    const deadline = system.now() + readyTimeoutMs;
    const live = () => {
      if (signal.aborted) throw new PreviewCancelled();
    };
    const until = async (check: () => Promise<boolean>, timeout: string) => {
      while ((live(), !(await check()))) {
        live();
        if (exited) throw new PreviewFailure("The preview command exited before it was ready.");
        if (system.now() >= deadline) throw new PreviewFailure(timeout);
        await system.sleep(pollMs, signal).catch(live);
      }
    };
    await until(
      () => system.answers(preview.port),
      `Nothing answered on port ${preview.port} in time.`,
    );
    const tree = await system.tree(started.pid);
    const owners = await system.listeners(preview.port, tree);
    if (!owners.length || owners.some((pid) => pid === null || !tree.has(pid)))
      throw new PreviewFailure(
        `Port ${preview.port} is held by a process the preview command did not start.`,
      );
    live();
    const status = await system.tailscale(["status", "--json"]);
    const suffix = status.code === 0 ? magicDnsSuffix(status.stdout) : null;
    if (!suffix) throw new PreviewFailure("Tailscale did not report the tailnet name.");
    live();
    const serve = await system.tailscale([
      "serve",
      `--service=svc:${service}`,
      "--https=443",
      `http://127.0.0.1:${preview.port}`,
    ]);
    served = true;
    if (serve.code !== 0)
      throw new PreviewFailure(
        `tailscale serve failed: ${(serve.stderr || serve.stdout).trim().slice(0, 500)}`,
      );
    url = `https://${service}.${suffix}${preview.path ?? "/"}`;
    await until(() => system.warm(url, signal), `${url} did not answer in time.`);
  } catch (error) {
    await teardown();
    if (error instanceof PreviewCancelled || signal.aborted) {
      emit({ type: "preview", state: "stopped", service, reason: "run_ended" });
      return null;
    }
    emit({
      type: "preview",
      state: "stopped",
      service,
      reason: "failed",
      message:
        error instanceof PreviewFailure
          ? error.message
          : `The preview could not start: ${String(error).slice(0, 900)}`,
    });
    return null;
  }
  emit({ type: "preview", state: "ready", service, url });
  let resolve!: (reason: LivePreviewStopReason) => void;
  const stopped = new Promise<LivePreviewStopReason>((done) => (resolve = done));
  let ending: Promise<void> | undefined;
  const stop = (reason: LivePreviewStopReason) =>
    (ending ??= (async () => {
      clearTimeout(timer);
      await teardown();
      emit({ type: "preview", state: "stopped", service, reason });
      resolve(reason);
    })());
  const timer = setTimeout(
    () => void stop("time_limit"),
    input.timeLimitMs ?? (preview.timeLimitMinutes ?? LIVE_PREVIEW_TIME_LIMIT_MINUTES) * 60_000,
  );
  void child!.exited.then(() => stop("exited"));
  return { service, url, stop, stopped };
}

function magicDnsSuffix(json: string): string | null {
  try {
    const suffix = (JSON.parse(json) as { MagicDNSSuffix?: unknown }).MagicDNSSuffix;
    return typeof suffix === "string" && /^[A-Za-z0-9.-]+$/.test(suffix)
      ? suffix.replace(/\.$/, "")
      : null;
  } catch {
    return null;
  }
}
