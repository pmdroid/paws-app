import { repoApiPath } from "../client";
import type { GitHubClient } from "../types";

/** Label on pull requests opened with the developer's gh login. */
export const PAWS_LABEL = "paws";

/**
 * Body marker for a pull request opened with gh auth.
 * The developer is the author; this records that Paws supplied the evidence.
 */
export const PAWS_EVIDENCE_MARKER = "<!-- paws-evidence -->";

export function withPawsEvidenceMarker(body: string): string {
  if (body.includes(PAWS_EVIDENCE_MARKER)) {
    return body.endsWith("\n") ? body : `${body}\n`;
  }
  const trimmed = body.replace(/\s*$/, "");
  return `${trimmed}\n\n${PAWS_EVIDENCE_MARKER}\n`;
}

export async function applyPawsLabel(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  number: number;
  token: string;
}): Promise<void> {
  const created = await input.client.request({
    method: "POST",
    path: repoApiPath(input.owner, input.repo, "/labels"),
    token: input.token,
    body: {
      name: PAWS_LABEL,
      color: "1D76DB",
      description: "Opened by Paws",
    },
  });
  if (created.status !== 201 && created.status !== 422) {
    throw new Error(`creating the paws label failed with status ${created.status}`);
  }
  const added = await input.client.request({
    method: "POST",
    path: repoApiPath(input.owner, input.repo, `/issues/${input.number}/labels`),
    token: input.token,
    body: { labels: [PAWS_LABEL] },
  });
  if (added.status !== 200 && added.status !== 201) {
    throw new Error(`adding the paws label failed with status ${added.status}`);
  }
}
