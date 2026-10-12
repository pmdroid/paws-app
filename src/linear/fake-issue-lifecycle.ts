import type {
  LinearIssueLifecycle,
  LinearIssueOwnership,
  StartLinearCodeIssue,
} from "./issue-lifecycle";

export function createFakeLinearIssueLifecycle(initial: LinearIssueOwnership) {
  const issues = new Map<string, LinearIssueOwnership>();
  const inspected: string[] = [];
  const started: StartLinearCodeIssue[] = [];
  const fake: LinearIssueLifecycle & {
    issue: LinearIssueOwnership;
    issues: Map<string, LinearIssueOwnership>;
    eligible: boolean;
    inspected: string[];
    started: StartLinearCodeIssue[];
  } = {
    issue: { ...initial },
    issues,
    eligible: true,
    inspected,
    started,
    async inspect(issueId, options) {
      options?.signal?.throwIfAborted();
      inspected.push(issueId);
      const issue = issueId === fake.issue.id ? fake.issue : issues.get(issueId);
      if (issue === undefined) throw new Error("The fake Linear issue was not configured.");
      return { ...issue };
    },
    async startCodeIssue(input, options) {
      options?.signal?.throwIfAborted();
      const issue = input.issueId === fake.issue.id ? fake.issue : issues.get(input.issueId);
      if (issue === undefined) throw new Error("The fake Linear issue was not configured.");
      const eligible = fake.eligible && input.actorId !== null;
      if (eligible) options?.beforeStart?.({ ...issue });
      options?.signal?.throwIfAborted();
      started.push(input);
      if (eligible) {
        issue.delegateId = input.appUserId;
        issue.stateType = "started";
      }
      return { issue: { ...issue }, eligible };
    },
  };
  return fake;
}
