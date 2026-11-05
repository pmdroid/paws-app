import type { AcpEvent } from "../acp";

export const AGENT_WAIT_AFTER_MS = 2 * 60_000;

export type AgentWaitEvent =
  | { type: "agent_wait_started"; kind?: string; title?: string }
  | { type: "agent_wait_ended"; kind?: string; title?: string; waitedMs: number };

type ToolCall = { kind?: string; title?: string };

export type AgentWaitTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
};

const systemTimers: AgentWaitTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

export function agentWaitTracker(
  emit: (event: AgentWaitEvent) => void,
  timers: AgentWaitTimers = systemTimers,
) {
  const running = new Map<string, ToolCall>();
  let timer: unknown;
  let waiting: (ToolCall & { since: number }) | undefined;
  let last: string | undefined;

  function end() {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    if (waiting) {
      const { since, ...call } = waiting;
      emit({ type: "agent_wait_ended", ...call, waitedMs: Math.round(timers.now() - since) });
    }
    waiting = undefined;
  }

  function arm() {
    if (!running.size) return;
    timer = timers.set(() => {
      timer = undefined;
      const call = (last && running.get(last)) || [...running.values()].at(-1);
      if (!call) return;
      waiting = { ...call, since: timers.now() };
      emit({ type: "agent_wait_started", ...call });
    }, AGENT_WAIT_AFTER_MS);
  }

  function stop() {
    running.clear();
    end();
  }

  return {
    observe(event: AcpEvent) {
      if (event.type === "prompt_complete" || event.type === "cancelled" || event.type === "error")
        return stop();
      if (event.type !== "session_update") return;
      const update = event.update;
      if (update.sessionUpdate === "usage_update") return;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const known = running.get(update.toolCallId);
        const done = update.status === "completed" || update.status === "failed";
        if (known && !done) {
          if (update.kind) known.kind = update.kind;
          if (update.title) known.title = update.title.slice(0, 256);
          if (update.sessionUpdate === "tool_call_update") return;
        }
        if (done) running.delete(update.toolCallId);
        else if (!known && (update.sessionUpdate === "tool_call" || update.status)) {
          running.set(update.toolCallId, {
            ...(update.kind ? { kind: update.kind } : {}),
            ...(update.title ? { title: update.title.slice(0, 256) } : {}),
          });
          last = update.toolCallId;
        }
      }
      end();
      arm();
    },
    stop,
  };
}
