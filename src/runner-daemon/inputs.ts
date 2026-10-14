import { createHash } from "node:crypto";
import { z } from "zod";
import { RUNNER_INPUT_CHUNK_BYTES, type RunnerCommand } from "../runner-protocol";

export type RunnerDownloadedInputs = { inputFiles: Uint8Array[]; promptContext?: Uint8Array };
type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" | "task" }>;
const chunk = z.strictObject({
  commandId: z.string(),
  offset: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: z.string().max(699052),
});
const fileChunk = chunk.extend({ fileId: z.number().int().min(0).max(20) });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function downloadRunnerInputs(
  command: WorkCommand,
  getGrant: () => Promise<string>,
  fetchChunk: (channel: "inputs" | "context", body: unknown, token: string) => Promise<unknown>,
  signal: AbortSignal,
): Promise<RunnerDownloadedInputs> {
  async function download(descriptor: { sizeBytes: number; sha256: string }, fileId?: number) {
    const parts: Buffer[] = [];
    let offset = 0;
    do {
      signal.throwIfAborted();
      const token = await getGrant();
      signal.throwIfAborted();
      const request = {
        commandId: command.id,
        generation: command.generation,
        offset,
        ...(fileId === undefined ? {} : { fileId }),
      };
      const response = await fetchChunk(
        fileId === undefined ? "context" : "inputs",
        request,
        token,
      );
      signal.throwIfAborted();
      const result = fileId === undefined ? chunk.parse(response) : fileChunk.parse(response);
      const bytes = Buffer.from(result.data, "base64");
      if (
        result.commandId !== command.id ||
        result.offset !== offset ||
        (fileId !== undefined && (result as z.infer<typeof fileChunk>).fileId !== fileId) ||
        bytes.toString("base64") !== result.data ||
        bytes.length !== Math.min(RUNNER_INPUT_CHUNK_BYTES, descriptor.sizeBytes - offset) ||
        hash(bytes) !== result.sha256
      )
        throw new Error("Runner input chunk integrity failed");
      parts.push(bytes);
      offset += bytes.length;
    } while (offset < descriptor.sizeBytes);
    const bytes = Buffer.concat(parts);
    if (bytes.length !== descriptor.sizeBytes || hash(bytes) !== descriptor.sha256)
      throw new Error("Runner input content integrity failed");
    return bytes;
  }
  const inputFiles: Uint8Array[] = [];
  for (const file of command.inputFiles ?? []) inputFiles.push(await download(file, file.id));
  const promptContext = command.promptContext ? await download(command.promptContext) : undefined;
  if (promptContext && !Buffer.from(promptContext.toString("utf8"), "utf8").equals(promptContext))
    throw new Error("Runner prompt context is not UTF-8");
  signal.throwIfAborted();
  return { inputFiles, ...(promptContext ? { promptContext } : {}) };
}
