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

export type RepositoryHints = {
  mentions: string[];
  issueLabels: string[];
  parentLabels: string[];
  projectLabels: string[];
};

export const NO_REPOSITORY_HINTS: RepositoryHints = {
  mentions: [],
  issueLabels: [],
  parentLabels: [],
  projectLabels: [],
};

export interface LinearRepositoryAdapter {
  issueRepositorySuggestions(
    input: RepositorySuggestionsInput,
    options?: TrackerRequestOptions,
  ): Promise<readonly RepositorySuggestion[]>;
  issueRepositoryHints?(issueId: string, options?: TrackerRequestOptions): Promise<RepositoryHints>;
  addRepositoryLabel?(
    input: { issueId: string; repository: string },
    options?: TrackerRequestOptions,
  ): Promise<void>;
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

const LABELS = "labels(first: 50) { nodes { name parent { name } } }";

const HINTS_QUERY = `query IssueRepositoryHints($id: String!) {
  issue(id: $id) {
    description
    ${LABELS}
    parent { ${LABELS} }
    project { ${LABELS} }
    comments(first: 100) { nodes { body createdAt } }
  }
}`;

const LABEL_ISSUE = `query RepositoryLabelIssue($id: String!) {
  issue(id: $id) { ${LABELS} }
}`;

const LABEL_GROUPS = `query RepositoryLabelGroups {
  issueLabels(first: 1, filter: { isGroup: { eq: true }, name: { eqIgnoreCase: "repo" }, team: { null: true } }) {
    nodes { id }
  }
}`;

const LABELS_IN_GROUP = `query RepositoryLabels($group: ID!, $name: String!) {
  issueLabels(first: 1, filter: { parent: { id: { eq: $group } }, name: { eqIgnoreCase: $name } }) {
    nodes { id }
  }
}`;

const CREATE_LABEL = `mutation RepositoryLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id } }
}`;

const ADD_LABEL = `mutation RepositoryLabelAdd($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success }
}`;

function dig(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : null;
}

const REPO_NAME = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const REPO_MENTION = /\[repo=([a-z0-9_.-]+\/[a-z0-9_.-]+)\]/gi;

function nodes(connection: unknown): unknown[] {
  return isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
}

function repoLabels(connection: unknown): string[] {
  return nodes(connection).flatMap((label) =>
    isRecord(label) &&
    typeof label["name"] === "string" &&
    REPO_NAME.test(label["name"]) &&
    isRecord(label["parent"]) &&
    typeof label["parent"]["name"] === "string" &&
    label["parent"]["name"].toLowerCase() === "repo"
      ? [label["name"]]
      : [],
  );
}

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
    async issueRepositoryHints(issueId, options) {
      options?.signal?.throwIfAborted();
      const data = await client.query(HINTS_QUERY, { id: issueId }, options);
      options?.signal?.throwIfAborted();
      const issue = isRecord(data) ? data["issue"] : null;
      if (!isRecord(issue)) throw new Error("Linear returned no issue for repository hints");
      const comments = nodes(issue["comments"])
        .filter(isRecord)
        .map((comment) => ({
          body: typeof comment["body"] === "string" ? comment["body"] : "",
          at: typeof comment["createdAt"] === "string" ? comment["createdAt"] : "",
        }))
        .sort((left, right) => left.at.localeCompare(right.at));
      const description = typeof issue["description"] === "string" ? issue["description"] : "";
      return {
        mentions: [description, ...comments.map((comment) => comment.body)].flatMap((text) =>
          [...text.matchAll(REPO_MENTION)].map((match) => match[1]!),
        ),
        issueLabels: repoLabels(issue["labels"]),
        parentLabels: repoLabels(isRecord(issue["parent"]) ? issue["parent"]["labels"] : null),
        projectLabels: repoLabels(isRecord(issue["project"]) ? issue["project"]["labels"] : null),
      };
    },
    async addRepositoryLabel(input, options) {
      const issue = dig(await client.query(LABEL_ISSUE, { id: input.issueId }, options), "issue");
      if (!isRecord(issue)) throw new Error("Linear returned no issue for the repository label");
      if (repoLabels(issue["labels"]).length > 0) return;
      const groups = nodes(dig(await client.query(LABEL_GROUPS, {}, options), "issueLabels"));
      const existing = isRecord(groups[0]) ? groups[0]["id"] : null;
      const group =
        typeof existing === "string"
          ? existing
          : await createLabel({ name: "repo", isGroup: true });
      const found =
        typeof existing === "string"
          ? nodes(
              dig(
                await client.query(LABELS_IN_GROUP, { group, name: input.repository }, options),
                "issueLabels",
              ),
            )
          : [];
      const label =
        isRecord(found[0]) && typeof found[0]["id"] === "string"
          ? found[0]["id"]
          : await createLabel({ name: input.repository, parentId: group });
      const added = dig(
        await client.query(ADD_LABEL, { id: input.issueId, labelId: label }, options),
        "issueAddLabel",
      );
      if (!isRecord(added) || added["success"] !== true)
        throw new Error("Linear did not add the repository label");
      async function createLabel(labelInput: Record<string, unknown>): Promise<string> {
        const created = dig(
          await client.query(CREATE_LABEL, { input: labelInput }, options),
          "issueLabelCreate",
        );
        const id = isRecord(created) ? dig(created, "issueLabel") : null;
        if (!isRecord(created) || created["success"] !== true || !isRecord(id))
          throw new Error("Linear did not create the repository label");
        const value = id["id"];
        if (typeof value !== "string")
          throw new Error("Linear did not create the repository label");
        return value;
      }
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
