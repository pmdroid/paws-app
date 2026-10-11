import type { ContentBlock, PromptCapabilities } from "@agentclientprotocol/sdk";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type AgentInputFile = { path: string; mimeType: string; bytes: Uint8Array };

export function snapshotAgentInputs(
  worktree: string,
  files: readonly AgentInputFile[] = [],
): AgentInputFile[] {
  if (files.length > 20) throw new Error("Agent input files exceed the file limit");
  let size = 0;
  return files.map((file) => {
    const path = resolve(worktree, file.path);
    const local = relative(worktree, path);
    size += file.bytes.byteLength;
    if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
      throw new Error("Agent input files must be inside the workspace");
    }
    if (
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mimeType) ||
      size > 20 * 1024 * 1024
    ) {
      throw new Error("Agent input files exceed the content limits");
    }
    return { path, mimeType: file.mimeType, bytes: new Uint8Array(file.bytes) };
  });
}

export function buildAgentPrompt(
  prompt: string,
  worktree: string,
  files: readonly AgentInputFile[],
  capabilities: PromptCapabilities = {},
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text: prompt }];
  for (const file of files) {
    const local = relative(worktree, file.path);
    blocks.push({ type: "text", text: `Input file: ./${local} (${file.mimeType})` });
    const uri = pathToFileURL(file.path).href;
    if (capabilities.image && /^image\/(png|jpeg|gif|webp)$/.test(file.mimeType)) {
      blocks.push({
        type: "image",
        data: Buffer.from(file.bytes).toString("base64"),
        mimeType: file.mimeType,
        uri,
      });
    } else if (capabilities.embeddedContext) {
      blocks.push({
        type: "resource",
        resource: {
          uri,
          mimeType: file.mimeType,
          blob: Buffer.from(file.bytes).toString("base64"),
        },
      });
    }
  }
  return blocks;
}
