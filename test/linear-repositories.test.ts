import { describe, expect, test } from "bun:test";
import {
  createFakeTracker,
  createLinearTracker,
  type CandidateRepository,
  type LinearClient,
} from "../src/linear";

const candidates: readonly CandidateRepository[] = [
  { hostname: "github.com", repositoryFullName: "pmdroid/paws-app" },
  { hostname: "github.com", repositoryFullName: "pmdroid/other" },
];

function fixture(suggestions: unknown) {
  const calls: { query: string; variables: unknown; signal: AbortSignal | undefined }[] = [];
  const client: LinearClient = {
    async query(query, variables, options) {
      calls.push({ query, variables, signal: options?.signal });
      return { issueRepositorySuggestions: { suggestions } };
    },
  };
  return { tracker: createLinearTracker(client), calls };
}

describe("Linear repository suggestions", () => {
  test("sends the public schema and maps ranked results back to eligible candidates", async () => {
    const { tracker, calls } = fixture([
      { hostname: null, repositoryFullName: "PMDROID/OTHER", confidence: 0.4 },
      { hostname: "GitHub.COM", repositoryFullName: "pmdroid/paws-app", confidence: 0.9 },
      { hostname: "github.com", repositoryFullName: "pmdroid/unconfigured", confidence: 1 },
      { hostname: "evil.example", repositoryFullName: "pmdroid/paws-app", confidence: 1 },
      { hostname: "github.com", repositoryFullName: "pmdroid/paws-app", confidence: 0.2 },
    ]);
    const signal = new AbortController().signal;
    const input = {
      issueId: "issue",
      agentSessionId: "session",
      candidateRepositories: candidates,
    };
    expect(await tracker.issueRepositorySuggestions(input, { signal })).toEqual([
      { ...candidates[0]!, confidence: 0.9 },
      { ...candidates[1]!, confidence: 0.4 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables).toEqual(input);
    expect(calls[0]?.signal).toBe(signal);
    expect(calls[0]?.query).toContain("$candidateRepositories: [CandidateRepository!]!");
    expect(calls[0]?.query).toContain("suggestions { repositoryFullName hostname confidence }");
  });

  test("does not infer a host for a repository present on multiple hosts", async () => {
    const { tracker } = fixture([
      { hostname: null, repositoryFullName: "pmdroid/paws-app", confidence: 1 },
    ]);
    expect(
      await tracker.issueRepositorySuggestions({
        issueId: "issue",
        candidateRepositories: [candidates[0]!, { ...candidates[0]!, hostname: "git.example" }],
      }),
    ).toEqual([]);
  });

  test("rejects malformed results instead of trusting their confidence", async () => {
    for (const suggestions of [
      null,
      [{}],
      [{ hostname: null, repositoryFullName: "pmdroid/paws-app", confidence: -1 }],
      [{ hostname: null, repositoryFullName: "pmdroid/paws-app", confidence: 1.1 }],
      [{ hostname: null, repositoryFullName: "pmdroid/paws-app", confidence: Number.NaN }],
    ]) {
      const { tracker } = fixture(suggestions);
      await expect(
        tracker.issueRepositorySuggestions({ issueId: "issue", candidateRepositories: candidates }),
      ).rejects.toThrow("Linear");
    }
  });

  test("validates candidates and cancellation before sending a request", async () => {
    const { tracker, calls } = fixture([]);
    for (const candidate of [
      { hostname: "https://github.com", repositoryFullName: "pmdroid/paws-app" },
      { hostname: "github.com", repositoryFullName: "pmdroid/paws-app/extra" },
      { hostname: "github.com", repositoryFullName: "../paws-app" },
    ]) {
      await expect(
        tracker.issueRepositorySuggestions({
          issueId: "issue",
          candidateRepositories: [candidate],
        }),
      ).rejects.toThrow("hostname and owner/repository");
    }
    expect(
      await tracker.issueRepositorySuggestions({ issueId: "issue", candidateRepositories: [] }),
    ).toEqual([]);
    await expect(
      tracker.issueRepositorySuggestions(
        { issueId: "issue", candidateRepositories: candidates },
        { signal: AbortSignal.abort(new Error("stopped")) },
      ),
    ).rejects.toThrow("stopped");
    expect(calls).toEqual([]);
  });

  test("checks cancellation again after the request returns", async () => {
    const controller = new AbortController();
    const tracker = createLinearTracker({
      async query() {
        controller.abort(new Error("stopped"));
        return { issueRepositorySuggestions: { suggestions: [] } };
      },
    });
    await expect(
      tracker.issueRepositorySuggestions(
        { issueId: "issue", candidateRepositories: candidates },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("stopped");
  });

  test("the fake records suggestions and enforces the same candidate boundary", async () => {
    const tracker = createFakeTracker();
    tracker.repositorySuggestions.set("issue", [
      { ...candidates[0]!, confidence: 0.7 },
      { hostname: "github.com", repositoryFullName: "pmdroid/not-allowed", confidence: 1 },
    ]);
    const input = { issueId: "issue", candidateRepositories: candidates };
    expect(await tracker.issueRepositorySuggestions(input)).toEqual([
      { ...candidates[0]!, confidence: 0.7 },
    ]);
    expect(tracker.repositorySuggestionRequests).toEqual([input]);
  });
});
