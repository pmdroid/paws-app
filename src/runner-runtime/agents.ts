import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  RUNNER_CODING_AGENTS,
  RunnerAgentTargetSchema,
  RunnerAgentVersionSchema,
  type RunnerAgentTarget,
  type RunnerInstalledAgent,
} from "../runner-protocol";

/** Where the package installs the agents, one folder per agent with a `current` pointer. */
export const RUNNER_AGENTS_BASE = "/opt/paws-runner";
/** The daemon writes the versions Paws sent here; `paws-runner-agents.path` installs them as root. */
export const RUNNER_AGENT_REQUESTS = "/var/lib/paws-runner/agent-requests.json";
/** What the root installer did with them. */
export const RUNNER_AGENT_STATUS = "/var/lib/paws-runner-agents/status.json";

const request = z.object({
  id: z.string(),
  version: RunnerAgentVersionSchema,
  status: z.enum(["installing", "waiting", "installed", "failed"]),
  sessions: z.number().int().min(0).max(1024).optional(),
  error: z.string().optional(),
});
const StatusSchema = z.object({
  format: z.literal(1),
  agents: z.record(z.string(), z.object({ request: request.nullable().optional() })),
});

/**
 * The runner's coding agents: what the heartbeat reports, and the hand-off of the versions Paws
 * sends to the root installer. The runner forwards only targets from the heartbeat reply, and the
 * installer refuses a lockfile whose agent package integrity is not the one Paws sent.
 */
export function openRunnerAgents(
  options: {
    base?: string;
    requests?: string;
    status?: string;
    onError?: (error: Error) => void;
  } = {},
) {
  const base = options.base ?? RUNNER_AGENTS_BASE;
  const requests = options.requests ?? RUNNER_AGENT_REQUESTS;
  const statusPath = options.status ?? RUNNER_AGENT_STATUS;
  /** The request file as this process last wrote it; null until the first write after start. */
  let written: string | null = null;
  let forwarded: RunnerAgentTarget[] = [];

  const folder = (agent: string) => join(base, "agents", agent);
  function current(agent: string): string | null {
    try {
      const target = readlinkSync(join(folder(agent), "current"));
      return RunnerAgentVersionSchema.safeParse(target).success ? target : null;
    } catch (caughtError1) {
      journalCaught(caughtError1, "agents.current.readlinkSync", null);
      return null;
    }
  }
  function readStatus(): z.infer<typeof StatusSchema>["agents"] {
    try {
      return StatusSchema.parse(JSON.parse(readFileSync(statusPath, "utf8"))).agents;
    } catch (error) {
      journalCaught(error, "agents.readStatus.parse", null, "optional file may be absent");
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        options.onError?.(new Error("Runner agent install status is unreadable."));
      return {};
    }
  }

  return {
    /** What the heartbeat reports; undefined on a host whose agents the installer does not manage. */
    installed(): RunnerInstalledAgent[] | undefined {
      if (!existsSync(join(base, "agents"))) return undefined;
      const status = readStatus();
      const rows: RunnerInstalledAgent[] = [];
      for (const agent of RUNNER_CODING_AGENTS) {
        const version = current(agent);
        if (version === null) continue;
        rows.push({ agent, version, status: "current" });
        const target = forwarded.find((entry) => entry.agent === agent);
        if (!target || target.version === version) continue;
        const done = status[agent]?.request;
        const answered = done?.id === target.id ? done : undefined;
        if (answered?.status === "failed")
          rows.push({
            agent,
            version: target.version,
            status: "failed",
            target: target.id,
            error: (answered.error ?? "").slice(0, 500) || "The install failed.",
          });
        else if (answered?.status === "waiting")
          rows.push({
            agent,
            version: target.version,
            status: "waiting",
            target: target.id,
            ...(answered.sessions === undefined ? {} : { sessions: answered.sessions }),
          });
        else rows.push({ agent, version: target.version, status: "installing", target: target.id });
      }
      return rows;
    },
    /** Forward the versions Paws sent to the root installer. Only these are ever installed. */
    apply(targets: readonly RunnerAgentTarget[]): void {
      const accepted = targets.map((candidate) => RunnerAgentTargetSchema.parse(candidate));
      forwarded = accepted;
      const content = JSON.stringify({
        format: 1,
        requests: accepted.map(({ id, agent, version, integrity, nativeVersion, packages }) => ({
          id,
          agent,
          version,
          integrity,
          nativeVersion,
          packages,
        })),
      });
      // Written once after every start, so a switch still waiting when the host restarted resumes.
      if (content === written) return;
      const partial = join(dirname(requests), `.agent-requests-${randomUUID()}.partial`);
      try {
        writeFileSync(partial, content, { mode: 0o600 });
        renameSync(partial, requests);
        written = content;
      } finally {
        rmSync(partial, { force: true });
      }
    },
  };
}

export type RunnerAgents = ReturnType<typeof openRunnerAgents>;
