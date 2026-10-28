import {
  createFakeRunFileObjects,
  createLocalRunFileObjects,
  createS3RunFileObjects,
  loadRunFileKey,
  RUN_FILE_KINDS,
  type RunFileObjects,
} from "../run-files";

export {
  AgentSessionChunkSchema,
  AgentSessionFinishSchema,
  AgentSessionReadSchema,
  AGENT_SESSION_CHUNK_BYTES,
  AGENT_SESSION_MAX_BYTES,
  type AgentSessionChunk,
  type AgentSessionFinish,
  type AgentSessionRead,
} from "./schema";
export {
  createAgentSessions,
  AgentSessionRefusedError,
  type AgentSessions,
  type AgentSessionSnapshot,
} from "./store";
export { createAgentSessionsHttp } from "./http";
export {
  RunFileStorageError as AgentSessionStorageError,
  withLocalRunFileFallback as withLocalAgentSessionFallback,
} from "../run-files";

// Snapshots are the `agent_session` kind of run file; these name its key and objects.
export type AgentSessionObjects = RunFileObjects;
export const AGENT_SESSION_KEY_FILE = RUN_FILE_KINDS.agent_session.keyFile;
export const loadAgentSessionKey = (path: string) => loadRunFileKey("agent_session", path);
export const createLocalAgentSessionObjects = (root: string) =>
  createLocalRunFileObjects("agent_session", root);
export const createS3AgentSessionObjects = (
  options: Parameters<typeof createS3RunFileObjects>[1],
) => createS3RunFileObjects("agent_session", options);
export const createFakeAgentSessionObjects = createFakeRunFileObjects;
