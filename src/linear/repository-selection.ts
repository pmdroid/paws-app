import type { RepositoryBinding } from "../core";
import type { RepositoryHints, RepositorySuggestion } from "./repositories";

export function repositoryAnswer(
  answer: string,
  candidates: readonly RepositoryBinding[],
): RepositoryBinding | null {
  const value = answer.trim().toLowerCase();
  if (/^[1-9]\d*$/.test(value)) return candidates[Number(value) - 1] ?? null;
  const matches = candidates.filter((candidate) => {
    const fullName = `${candidate.owner}/${candidate.repo}`.toLowerCase();
    return (
      value === fullName ||
      value === `https://github.com/${fullName}` ||
      value === `https://github.com/${fullName}.git` ||
      value === candidate.repo.toLowerCase()
    );
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

const CONFIDENT = 0.6;
const LEAD = 0.1;
const OFFERED = 3;

export function chooseRepository(
  candidates: readonly RepositoryBinding[],
  suggestions: readonly RepositorySuggestion[],
): { bind: RepositoryBinding } | { ask: RepositoryBinding[] } {
  const known = suggestions
    .filter((suggestion) =>
      candidates.some(
        (candidate) =>
          `${candidate.owner}/${candidate.repo}`.toLowerCase() ===
          suggestion.repositoryFullName.toLowerCase(),
      ),
    )
    .sort((left, right) => right.confidence - left.confidence);
  const ranked = rankRepositories(candidates, known);
  const [top, next] = known;
  if (top && top.confidence >= CONFIDENT && top.confidence - (next?.confidence ?? 0) >= LEAD)
    return { bind: ranked[0]! };
  return { ask: ranked.slice(0, OFFERED) };
}

export function hintedRepository(
  candidates: readonly RepositoryBinding[],
  hints: RepositoryHints,
): { bind: RepositoryBinding } | { ask: RepositoryBinding[] } | null {
  const levels = [
    [...hints.mentions].reverse(),
    hints.issueLabels,
    hints.parentLabels,
    hints.projectLabels,
  ];
  for (const [index, names] of levels.entries()) {
    const matches: RepositoryBinding[] = [];
    for (const name of names) {
      const match = candidates.find(
        (candidate) => `${candidate.owner}/${candidate.repo}`.toLowerCase() === name.toLowerCase(),
      );
      if (match && !matches.includes(match)) matches.push(match);
    }
    if (index === 0 && matches.length > 0) return { bind: matches[0]! };
    if (matches.length === 1) return { bind: matches[0]! };
    if (matches.length > 1) return { ask: matches.slice(0, OFFERED) };
  }
  return null;
}
