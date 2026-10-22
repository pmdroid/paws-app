import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfile } from "../config";
import { runAgent } from "./run";

export async function probeAgentProfile(input: {
  profile: AgentProfile;
  pawsRoot: string;
  worktree: string;
  signal?: AbortSignal;
}): Promise<{
  ok: boolean;
  agent: AgentProfile["agent"];
  model: string | null;
  models: Array<{ id: string; name: string; description?: string }>;
  effort: string | null;
  efforts: Array<{ id: string; name: string }>;
  message: string;
}> {
  const worktree = await mkdtemp(join(tmpdir(), "paws-connection-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await runAgent({
      profile: input.profile,
      role: "reviewer",
      itemId: "connection",
      runId: `connection-${randomUUID()}`,
      worktreePath: worktree,
      pawsRoot: input.pawsRoot,
      checkpoint: false,
      readOnly: true,
      prompt: "Reply with OK only. Do not use tools.",
      timeoutMs: 20_000,
      signal: controller.signal,
    });
    const ok =
      result.stopReason === "end_turn" && result.identity !== undefined && !result.errorMessage;
    return {
      ok,
      agent: input.profile.agent,
      model: result.identity?.model ?? null,
      models: result.models ?? [],
      effort: result.effort ?? null,
      efforts: result.efforts ?? [],
      message: ok
        ? "Connection succeeded"
        : (result.errorMessage ?? "Agent did not confirm its model"),
    };
  } catch (error) {
    return {
      ok: false,
      agent: input.profile.agent,
      model: null,
      models: [],
      effort: null,
      efforts: [],
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    await rm(worktree, { recursive: true, force: true });
  }
}
