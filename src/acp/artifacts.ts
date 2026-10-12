import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentRole } from "./adapters";

export const PUBLISH_ARTIFACT_TOOL_NAME = "publish_artifact";
export const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export interface PublishArtifactRequest {
  path: string;
  displayName?: string;
  mimeType?: string;
}

export interface ArtifactLimits {
  maxBytes?: number;
}

export interface ArtifactSnapshot {
  path: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  bytes: Blob;
}

export interface PublishArtifactContext {
  request?: PublishArtifactRequest;
  itemId: string;
  runId: string;
  worktreePath: string;
  role: AgentRole;
  signal: AbortSignal;
}

export interface PublishedArtifact {
  url: string;
  displayName?: string;
}

export interface PublishArtifactHook {
  begin?(request: PublishArtifactRequest, context: PublishArtifactContext): { complete(): void };
  publish(artifact: ArtifactSnapshot, context: PublishArtifactContext): Promise<PublishedArtifact>;
}

export async function snapshotArtifactFile(
  worktreePath: string,
  request: PublishArtifactRequest,
  limits: ArtifactLimits = {},
  signal?: AbortSignal,
): Promise<ArtifactSnapshot> {
  signal?.throwIfAborted();
  if (
    typeof request.path !== "string" ||
    !request.path.trim() ||
    isAbsolute(request.path) ||
    request.path.includes("\\") ||
    request.path.includes("\0") ||
    request.path.split("/").includes("..")
  ) {
    throw new Error("publish_artifact requires a workspace-relative path");
  }
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("invalid artifact byte limit");
  assertNonSecretPath(request.path);
  let root: string;
  let path: string;
  try {
    root = await realpath(worktreePath);
    path = await realpath(resolve(root, request.path));
  } catch {
    throw new Error("artifact file could not be read");
  }
  assertArtifactPath(root, path);
  const displayName = request.displayName ?? basename(path);
  if (
    typeof displayName !== "string" ||
    !displayName.trim() ||
    displayName.length > 255 ||
    [...displayName].some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        "/\\".includes(character),
    )
  ) {
    throw new Error("invalid artifact display name");
  }
  const mimeType = request.mimeType ?? mimeFor(path);
  if (typeof mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) {
    throw new Error("invalid artifact MIME type");
  }
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new Error("artifact file could not be read");
  });
  try {
    signal?.throwIfAborted();
    const info = await file.stat();
    if (!info.isFile()) throw new Error("artifact must be a regular file");
    if (info.size > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes`);
    const openedPath =
      process.platform === "linux"
        ? await realpath(`/proc/self/fd/${file.fd}`)
        : await realpath(path);
    assertArtifactPath(root, openedPath);
    const current = await stat(openedPath);
    if (current.dev !== info.dev || current.ino !== info.ino)
      throw new Error("artifact file changed");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes`);
    const after = await file.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    ) {
      throw new Error("artifact file changed while taking a snapshot");
    }
    signal?.throwIfAborted();
    const snapshot = buffer.subarray(0, size);
    return {
      path: request.path,
      displayName,
      mimeType,
      sizeBytes: size,
      sha256: createHash("sha256").update(snapshot).digest("hex"),
      bytes: new Blob([snapshot], { type: mimeType }),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw new Error("artifact file could not be read", { cause: error });
    }
    throw error;
  } finally {
    await file.close();
  }
}

function assertArtifactPath(root: string, path: string): void {
  if (path === root || !path.startsWith(`${root}${sep}`)) {
    throw new Error("artifact path is outside the workspace");
  }
  assertNonSecretPath(relative(root, path));
}

function assertNonSecretPath(path: string): void {
  const names = path.toLowerCase().split(/[/\\]/);
  if (
    names.some((name) =>
      /^(?:\.env(?:\..*)?|\.(?:git|paws|ssh|aws|claude|codex|grok|gnupg|npmrc|netrc|git-credentials)|secrets?(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/.test(
        name,
      ),
    ) ||
    /(?:^|\/)(?:\.config\/(?:gh|gcloud)|\.local\/share\/keyrings|library\/keychains)(?:\/|$)/.test(
      path.toLowerCase(),
    )
  ) {
    throw new Error("artifact path contains secrets or credentials");
  }
}

function mimeFor(path: string): string {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".zip": "application/zip",
    ".html": "text/html",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".txt": "text/plain",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}
