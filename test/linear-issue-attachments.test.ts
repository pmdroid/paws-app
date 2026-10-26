import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createLinearTracker } from "../src/linear";
import type { IssueAttachment, LinearClient } from "../src/linear";

function fixture() {
  const input: IssueAttachment = {
    id: randomUUID(),
    issueId: "issue",
    title: "Screenshot.png",
    url: "https://uploads.linear.app/workspace/shot.png",
  };
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];
  let remote: unknown = null;
  let lost = false;
  const client: LinearClient = {
    async query(query, variables, options) {
      options?.signal?.throwIfAborted();
      calls.push({ query, variables });
      if (query.startsWith("query")) return { attachments: { nodes: remote ? [remote] : [] } };
      const value = variables!["input"] as IssueAttachment;
      remote = { id: value.id, title: value.title, url: value.url, issue: { id: value.issueId } };
      if (lost) {
        lost = false;
        throw new Error("lost mutation response");
      }
      return { attachmentCreate: { success: true, attachment: remote } };
    },
  };
  return {
    input,
    calls,
    tracker: () => createLinearTracker(client),
    loseResponse() {
      lost = true;
    },
    setRemote(value: unknown) {
      remote = value;
    },
  };
}

test("attachment adapter sends exact public input and reconciles an uncertain result on a fresh adapter", async () => {
  const f = fixture();
  f.loseResponse();
  await expect(f.tracker().createIssueAttachment!(f.input)).rejects.toThrow(
    "lost mutation response",
  );
  expect(f.calls[0]!.variables).toEqual({ id: f.input.id });
  expect(f.calls[0]!.query).toContain("filter: {id: {eq: $id}}");
  expect(f.calls[1]!.variables).toEqual({ input: f.input });
  expect(f.calls[1]!.query).toContain("AttachmentCreateInput!");
  await f.tracker().createIssueAttachment!(f.input);
  expect(f.calls.filter((call) => call.query.startsWith("mutation"))).toHaveLength(1);
});

for (const field of ["id", "title", "url", "issueId"] as const) {
  test(`attachment lookup rejects mismatched ${field} instead of accepting another deliverable`, async () => {
    const f = fixture();
    const bad = { ...f.input, [field]: "different" };
    f.setRemote({ id: bad.id, title: bad.title, url: bad.url, issue: { id: bad.issueId } });
    await expect(f.tracker().createIssueAttachment!(f.input)).rejects.toThrow("does not match");
    expect(f.calls).toHaveLength(1);
  });
}

for (const update of [
  { id: "not-a-uuid" },
  { url: "https://evil.example/secret" },
  { url: "https://uploads.linear.app/shot?token=private" },
  { title: "bad\nname" },
]) {
  test(`attachment validation rejects ${Object.keys(update)[0]} before transport`, async () => {
    const f = fixture();
    await expect(f.tracker().createIssueAttachment!({ ...f.input, ...update })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
}

test("an aborted attachment never starts remote lookup", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.tracker().createIssueAttachment!(f.input, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("evidence links can use the Paws URL without leaking the evidence flag to GraphQL", async () => {
  const f = fixture();
  const input = { ...f.input, url: "https://paws.example/evidence/shot", evidence: true };
  await f.tracker().createIssueAttachment!(input);
  expect(f.calls[1]?.variables).toEqual({ input: { ...f.input, url: input.url } });
});

test("deleting a previous head's attachment reconciles a lost delete response", async () => {
  const id = randomUUID();
  let exists = true;
  let mutations = 0;
  const tracker = createLinearTracker({
    async query(query) {
      if (query.startsWith("query")) return { attachments: { nodes: exists ? [{ id }] : [] } };
      expect(query).toContain("attachmentDelete");
      mutations++;
      exists = false;
      throw new Error("lost delete response");
    },
  });
  await expect(tracker.deleteIssueAttachment!(id)).rejects.toThrow("lost delete response");
  await tracker.deleteIssueAttachment!(id);
  expect(mutations).toBe(1);
});
