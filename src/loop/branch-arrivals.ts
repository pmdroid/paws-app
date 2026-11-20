import type { BranchArrival } from "../github";

export function arrivalsPrompt(branch: string, commits: readonly BranchArrival[]): string {
  return [
    `Since the last turn, commits that Paws didn't push arrived on ${branch}:`,
    ...commits.slice(0, 10).map((c) => `${c.sha.slice(0, 7)} ${c.author} ${c.subject}`),
    "Your checkout starts from them. Keep these changes and build on them; don't revert or rewrite them unless the issue or a person asks.",
  ].join("\n");
}

export function arrivalsThought(branch: string, count: number): string {
  return `Continuing from ${count} commits on ${branch} that Paws didn't push.`;
}

export function branchMovedHandoff(branch: string): string {
  return `Someone pushed to ${branch} while you worked. Start from their commits and redo what is still needed.`;
}
