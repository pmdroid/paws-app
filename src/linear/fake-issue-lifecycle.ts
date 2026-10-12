import type {
  LinearIssueLifecycle,
  LinearIssueOwnership,
  StartLinearCodeIssue,
} from "./issue-lifecycle";

export function createFakeLinearIssueLifecycle(initial: LinearIssueOwnership) {
  const inspected: string[] = [];
  const started: StartLinearCodeIssue[] = [];
  const fake: LinearIssueLifecycle & {
    issue: LinearIssueOwnership;
    eligible: boolean;
    inspected: string[];
    started: StartLinearCodeIssue[];
  } = {
    issue: { ...initial },
    eligible: true,
    inspected,
    started,
    async inspect(issueId, options) {
      options?.signal?.throwIfAborted();
      inspected.push(issueId);
      return { ...fake.issue };
    },
    async startCodeIssue(input, options) {
      options?.signal?.throwIfAborted();
      started.push(input);
      return { issue: { ...fake.issue }, eligible: fake.eligible };
    },
  };
  return fake;
}
