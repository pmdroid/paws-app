import { createHash } from "node:crypto";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubCredentialInput } from "./auth/types";
import { repoApiPath } from "./client";
import { GitHubHttpError, type GitHubClient, type GitHubResponse } from "./types";

export const EVIDENCE_REF = "refs/paws/evidence";

export const EVIDENCE_REF_ATTEMPTS = 3;

export type StoredEvidenceFiles = {
  commit: string;
  files: string[];
};

export async function storeEvidenceFiles(
  input: {
    client: GitHubClient;
    owner: string;
    repo: string;
    issue: string;
    files: readonly { bytes: Uint8Array; extension: string }[];
    signal?: AbortSignal;
  } & GitHubCredentialInput,
): Promise<StoredEvidenceFiles> {
  const token = await acquireOperationToken(input, "push");
  const call = async (method: "GET" | "POST" | "PATCH", suffix: string, body?: unknown) => {
    input.signal?.throwIfAborted();
    return input.client.request({
      method,
      path: repoApiPath(input.owner, input.repo, suffix),
      token,
      ...(body === undefined ? {} : { body }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  };
  const files = input.files.map((file) => ({
    path: `${createHash("sha256").update(file.bytes).digest("hex")}.${file.extension}`,
    bytes: file.bytes,
  }));
  const names = files.map((file) => file.path);
  const blobs = new Map<string, string>();
  for (let attempt = 1; attempt <= EVIDENCE_REF_ATTEMPTS; attempt++) {
    const tip = await readTip(call);
    const present = tip ? await treePaths(call, tip.tree) : new Set<string>();
    const missing = files.filter((file) => !present.has(file.path));
    if (tip && missing.length === 0) return { commit: tip.commit, files: names };
    for (const file of missing) {
      if (blobs.has(file.path)) continue;
      const blob = expect(
        await call("POST", "/git/blobs", {
          content: Buffer.from(file.bytes).toString("base64"),
          encoding: "base64",
        }),
        201,
        "evidence blob",
      );
      blobs.set(file.path, field(blob, "sha"));
    }
    const tree = expect(
      await call("POST", "/git/trees", {
        ...(tip ? { base_tree: tip.tree } : {}),
        tree: [...new Set(missing.map((file) => file.path))].map((path) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: blobs.get(path),
        })),
      }),
      201,
      "evidence tree",
    );
    const commit = field(
      expect(
        await call("POST", "/git/commits", {
          message: `Paws evidence for ${input.issue} [skip ci]`,
          tree: field(tree, "sha"),
          parents: tip ? [tip.commit] : [],
        }),
        201,
        "evidence commit",
      ),
      "sha",
    );
    const moved = tip
      ? await call("PATCH", `/git/${EVIDENCE_REF}`, {
          sha: commit,
          force: false,
        })
      : await call("POST", "/git/refs", { ref: EVIDENCE_REF, sha: commit });
    if (moved.status === (tip ? 200 : 201)) return { commit, files: names };
    if (moved.status !== 422) throw new GitHubHttpError(moved);
  }
  throw new Error(
    `${EVIDENCE_REF} moved during each of ${EVIDENCE_REF_ATTEMPTS} attempts to store evidence`,
  );
}

type Call = (method: "GET" | "POST" | "PATCH", suffix: string) => Promise<GitHubResponse>;

async function readTip(call: Call): Promise<{ commit: string; tree: string } | null> {
  const ref = await call("GET", `/git/ref/${EVIDENCE_REF.slice("refs/".length)}`);
  if (ref.status === 404) return null;
  const object = record(expect(ref, 200, "evidence ref").object);
  const commit = field(object, "sha");
  const read = expect(await call("GET", `/git/commits/${commit}`), 200, "evidence ref commit");
  return { commit, tree: field(record(read.tree), "sha") };
}

async function treePaths(call: Call, tree: string): Promise<Set<string>> {
  const read = expect(await call("GET", `/git/trees/${tree}`), 200, "evidence tree");
  const entries = Array.isArray(read.tree) ? read.tree : [];
  return new Set(
    entries.flatMap((entry) => {
      const value = record(entry);
      return typeof value.path === "string" && value.type === "blob" ? [value.path] : [];
    }),
  );
}

function expect(response: GitHubResponse, status: number, what: string): Record<string, unknown> {
  if (response.status !== status)
    throw new GitHubHttpError(response, `${what}: GitHub HTTP ${response.status}`);
  return record(response.body);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function field(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0)
    throw new Error(`GitHub response has no ${key}`);
  return found;
}
