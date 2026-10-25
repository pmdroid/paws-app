import type { WorkItemRecord } from "../db";
import type { GitHubDenial, GitHubIntegration } from "./github-integration";

/**
 * A workspace GitHub App installation for tests. `installed` and `permitted` answer the checks;
 * a `GitHubDenial` in `permitted` denies with that reason. Every check is recorded in `checks`.
 */
export class FakeGitHubIntegration implements GitHubIntegration {
  installed = true;
  permitted: boolean | GitHubDenial = true;
  recoveryUrl = "http://127.0.0.1:8787/status/settings/integrations";
  admins: string[] = [];
  readonly checks: { itemId: string; kind: "installation" | "member" }[] = [];

  constructor(overrides: Partial<GitHubIntegration> = {}) {
    Object.assign(this, overrides);
  }

  async check(item: WorkItemRecord, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    this.checks.push({ itemId: item.id, kind: "installation" });
    return this.installed;
  }

  async authorize(item: WorkItemRecord, signal: AbortSignal): Promise<boolean | GitHubDenial> {
    signal.throwIfAborted();
    this.checks.push({ itemId: item.id, kind: "member" });
    return this.permitted;
  }

  administrators(_item: WorkItemRecord): readonly string[] {
    return this.admins;
  }

  identity(_item: WorkItemRecord): string {
    return "workspace-app";
  }
}
