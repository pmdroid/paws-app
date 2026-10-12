import type { RepositoryBinding } from "../core";
import type { RepositorySuggestion } from "../linear";

export function repositoryAnswer(
  answer: string,
  candidates: readonly RepositoryBinding[],
): RepositoryBinding | null {
  const value = answer.trim().toLowerCase();
  if (/^[1-9]\d*$/.test(value)) return candidates[Number(value) - 1] ?? null;
  const matches = candidates.filter((candidate) => {
    const fullName = `${candidate.owner}/${candidate.repo}`.toLowerCase();
    if (
      value === fullName ||
      value === `https://github.com/${fullName}` ||
      value === candidate.repo.toLowerCase()
    )
      return true;
    const escaped = fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9_./-])${escaped}(?:$|[^a-z0-9_./-])`, "i").test(value);
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function rankRepositories(
  candidates: readonly RepositoryBinding[],
  suggestions: readonly RepositorySuggestion[],
): RepositoryBinding[] {
  const rank = new Map(
    suggestions.map((suggestion, index) => [suggestion.repositoryFullName.toLowerCase(), index]),
  );
  return [...candidates].sort(
    (left, right) =>
      (rank.get(`${left.owner}/${left.repo}`.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(`${right.owner}/${right.repo}`.toLowerCase()) ?? Number.MAX_SAFE_INTEGER),
  );
}
