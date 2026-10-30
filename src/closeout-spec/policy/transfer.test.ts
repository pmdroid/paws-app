import { expect, test } from "bun:test";
import { decodePolicyFiles, encodePolicyFiles } from "./transfer";

const digest = `sha256:${"a".repeat(64)}`;

test("a skill larger than the old 64 KB file cap still crosses the policy transfer", () => {
  const skill = new Uint8Array(150_000);
  const files = new Map<string, Uint8Array>([
    [".agents/closeout.yaml", new TextEncoder().encode('specVersion: "0.1"\n')],
    [".agents/skills/verify-paws/SKILL.md", skill],
  ]);
  const encoded = encodePolicyFiles({ ok: true, absent: false, digest, files });
  expect(encoded).not.toContain("too large");
  const decoded = decodePolicyFiles(encoded);
  if (!decoded.ok || decoded.absent) throw new Error("the bundle did not survive the transfer");
  expect(decoded.files.size).toBe(2);
  expect(decoded.files.get(".agents/skills/verify-paws/SKILL.md")?.byteLength).toBe(150_000);
});

test("a bundle larger than the old 45 KB cap is sent instead of refused", () => {
  const files = new Map<string, Uint8Array>([
    [".agents/closeout.yaml", new TextEncoder().encode('specVersion: "0.1"\n')],
    [".agents/probes/api-contract.ts", new Uint8Array(60_000)],
    [".agents/skills/verify-paws/SKILL.md", new Uint8Array(120_000)],
  ]);
  const encoded = encodePolicyFiles({ ok: true, absent: false, digest, files });
  expect(encoded).not.toContain("too large");
  const decoded = decodePolicyFiles(encoded);
  expect(decoded.ok).toBe(true);
});

test("an empty preview approval list leaves the legacy strict transfer unchanged", () => {
  const files = new Map([
    [".agents/closeout.yaml", new TextEncoder().encode('specVersion: "0.1"\n')],
  ]);
  const encoded = encodePolicyFiles({
    ok: true,
    absent: false,
    digest,
    files,
    acceptedPreviews: [],
  });
  expect(Object.keys(JSON.parse(encoded)).sort()).toEqual(["digest", "files"]);
  const accepted = [{ checkId: "live-preview", commit: "b".repeat(40) }];
  expect(
    JSON.parse(
      encodePolicyFiles({ ok: true, absent: false, digest, files, acceptedPreviews: accepted }),
    ).acceptedPreviews,
  ).toEqual(accepted);
});
