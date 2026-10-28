/** Both kinds upload in chunks of this size; each stored chunk adds a 12-byte nonce and a 16-byte tag. */
export const RUN_FILE_CHUNK_BYTES = 524_288;
export const RUN_FILE_OBJECT_MAX_BYTES = RUN_FILE_CHUNK_BYTES + 28;

export const RUN_FILE_KINDS = {
  transcript: {
    title: "Runner transcript",
    noun: "transcript",
    keyFile: "runner-transcript.key",
    keyContext: "paws-runner-transcript-key\0",
    table: "runner_transcript",
    chunkTable: "runner_transcript_chunk",
    /** Chunks written before encryption keep their `.jsonl` name until they are converted. */
    suffix: ".jsonl",
  },
  agent_session: {
    title: "Agent session",
    noun: "agent session",
    keyFile: "agent-session.key",
    keyContext: "paws-agent-session-key\0",
    table: "agent_session_snapshot",
    chunkTable: "agent_session_snapshot_chunk",
    suffix: ".bin",
  },
} as const;

export type RunFileKind = keyof typeof RUN_FILE_KINDS;
