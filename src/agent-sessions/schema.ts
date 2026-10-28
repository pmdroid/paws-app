import { z } from "zod";
import { RUN_FILE_CHUNK_BYTES } from "../run-files";

export const AGENT_SESSION_CHUNK_BYTES = RUN_FILE_CHUNK_BYTES;
/** The largest sealed (gzipped) snapshot Paws accepts: 1 GiB. */
export const AGENT_SESSION_MAX_BYTES = 1_073_741_824;

const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const AgentSessionChunkSchema = z.strictObject({
  generation,
  offset: z.number().int().nonnegative().max(AGENT_SESSION_MAX_BYTES),
  sha256,
  data: z.string().max(Math.ceil(AGENT_SESSION_CHUNK_BYTES / 3) * 4),
});
export const AgentSessionFinishSchema = z.strictObject({
  generation,
  sizeBytes: z.number().int().nonnegative().max(AGENT_SESSION_MAX_BYTES),
  sha256,
  agent: z.enum(["claude", "codex", "grok"]),
  agentVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/),
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
  workspacePath: z
    .string()
    .max(4096)
    .regex(/^\/[^\0]*$/)
    .refine((path) => !path.split("/").some((part) => part === "." || part === "..")),
  commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  turn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
/** `generation` is the reader's current grant; `snapshotGeneration` is the snapshot to read. */
export const AgentSessionReadSchema = z.strictObject({
  generation,
  snapshotGeneration: generation,
});
export type AgentSessionChunk = z.infer<typeof AgentSessionChunkSchema>;
export type AgentSessionFinish = z.infer<typeof AgentSessionFinishSchema>;
export type AgentSessionRead = z.infer<typeof AgentSessionReadSchema>;
