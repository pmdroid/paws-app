import type { WorkItemRecord } from "../db";
import type { HostGitHubAuth, VerifiedGitHubAccount } from "./github-auth";

export class FakeHostGitHubAuth implements HostGitHubAuth {
  actorId: string | null = "linear-owner";
  linkedId: number | null = 7;
  account: VerifiedGitHubAccount | null = null;
  readonly challenges: {
    signal: AbortSignal;
    acceptAccount: (id: number) => boolean;
    complete: (account: VerifiedGitHubAccount) => void;
  }[] = [];

  owner(_item: WorkItemRecord): string | null {
    return this.actorId;
  }

  async linkedAccount(): Promise<number | null> {
    return this.linkedId;
  }

  async check(_item: WorkItemRecord, signal: AbortSignal): Promise<VerifiedGitHubAccount | null> {
    signal.throwIfAborted();
    return this.account;
  }

  async begin(
    _item: WorkItemRecord,
    input: { signal: AbortSignal; acceptAccount: (id: number) => boolean },
  ) {
    const completed = Promise.withResolvers<VerifiedGitHubAccount>();
    this.challenges.push({ ...input, complete: completed.resolve });
    return {
      url: "https://github.example/authorize?state=fake-csrf-state",
      completed: completed.promise.then((account) => {
        if (!input.acceptAccount(account.id)) throw new Error("Account verification rejected");
        this.account = account;
        return account;
      }),
    };
  }
}
