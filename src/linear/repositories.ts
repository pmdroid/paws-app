import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord } from "./read";

export type CandidateRepository = { hostname: string; repositoryFullName: string };

export type RepositorySuggestion = CandidateRepository & { confidence: number };

export type RepositorySuggestionsInput = {
  issueId: string;
  agentSessionId?: string;
  candidateRepositories: readonly CandidateRepository[];
};

export interface LinearRepositoryAdapter {
  issueRepositorySuggestions(
    input: RepositorySuggestionsInput,
    options?: TrackerRequestOptions,
  ): Promise<readonly RepositorySuggestion[]>;
}

const SUGGESTIONS_QUERY = `query IssueRepositorySuggestions(
  $issueId: String!, $agentSessionId: String, $candidateRepositories: [CandidateRepository!]!
) {
  issueRepositorySuggestions(
    issueId: $issueId, agentSessionId: $agentSessionId, candidateRepositories: $candidateRepositories
  ) {
    suggestions { repositoryFullName hostname confidence }
  }
}`;

export function createLinearRepositoryMethods(client: LinearClient): LinearRepositoryAdapter {
  return {
    async issueRepositorySuggestions(input, options) {
      options?.signal?.throwIfAborted();
      const candidates = repositoryCandidates(input);
      if (candidates.length === 0) return [];
      const data = await client.query(
        SUGGESTIONS_QUERY,
        { ...input, candidateRepositories: candidates },
        options,
      );
      options?.signal?.throwIfAborted();
      const result = isRecord(data) ? data["issueRepositorySuggestions"] : null;
      if (!isRecord(result) || !Array.isArray(result["suggestions"])) {
        throw new Error("Linear repository suggestions returned no suggestions array");
      }
      return authorizedRepositorySuggestions(candidates, result["suggestions"]);
    },
  };
}

export function repositoryCandidates(input: RepositorySuggestionsInput): CandidateRepository[] {
  if (input.issueId.trim().length === 0 || input.agentSessionId?.trim().length === 0) {
    throw new Error("Linear repository suggestions require nonempty issue and session identifiers");
  }
  const candidates = new Map<string, CandidateRepository>();
  for (const candidate of input.candidateRepositories) {
    if (
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(candidate.hostname) ||
      candidate.hostname.includes("..") ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(candidate.repositoryFullName) ||
      candidate.repositoryFullName.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error("Linear repository candidates require a hostname and owner/repository name");
    }
    const normalized = { ...candidate, hostname: candidate.hostname.toLowerCase() };
    candidates.set(repositoryKey(normalized), normalized);
  }
  return [...candidates.values()];
}

export function authorizedRepositorySuggestions(
  candidates: readonly CandidateRepository[],
  values: readonly unknown[],
): RepositorySuggestion[] {
  const suggestions = new Map<string, RepositorySuggestion>();
  for (const value of values) {
    if (
      !isRecord(value) ||
      typeof value["repositoryFullName"] !== "string" ||
      (value["hostname"] !== null && typeof value["hostname"] !== "string") ||
      typeof value["confidence"] !== "number" ||
      !Number.isFinite(value["confidence"]) ||
      value["confidence"] < 0 ||
      value["confidence"] > 1
    ) {
      throw new Error("Linear returned an invalid repository suggestion");
    }
    const fullName = value["repositoryFullName"].toLowerCase();
    const hostname = value["hostname"]?.toLowerCase();
    const matches = candidates.filter(
      (candidate) =>
        candidate.repositoryFullName.toLowerCase() === fullName &&
        (hostname === undefined || candidate.hostname.toLowerCase() === hostname),
    );
    if (matches.length !== 1) continue;
    const candidate = matches[0]!;
    const key = repositoryKey(candidate);
    const confidence = value["confidence"];
    const previous = suggestions.get(key);
    if (previous === undefined || confidence > previous.confidence) {
      suggestions.set(key, { ...candidate, confidence });
    }
  }
  return [...suggestions.values()].sort((left, right) => right.confidence - left.confidence);
}

function repositoryKey(candidate: CandidateRepository): string {
  return `${candidate.hostname}/${candidate.repositoryFullName}`.toLowerCase();
}
