import { journal } from "../journal";
import type { SlackReplyScope, SlackThreadModel } from "./threads";

export class SlackReplyLaneBusy extends Error {
  override readonly name = "SlackReplyLaneBusy";
  constructor() {
    super("The member's runner conversation lane is busy; Paws retries.");
  }
}

type ReplyLane<Profile> = {
  reply(request: {
    workspaceId: string;
    scope: SlackReplyScope;
    profile: Profile;
    prompt: string;
    signal: AbortSignal;
  }): Promise<{ status: "answered"; text: string } | { status: string }>;
};

export function slackRunnerModel<Profile>(
  lane: () => Promise<ReplyLane<Profile> | null>,
  profile: () => Profile,
): SlackThreadModel {
  return async ({ workspaceId, scope, prompt, signal }) => {
    const replies = await lane();
    if (!replies) {
      journal(`slack ${scope.requestId}: runner control is off; not answering`);
      return null;
    }
    const outcome = await replies.reply({ workspaceId, scope, profile: profile(), prompt, signal });
    if ("text" in outcome) return outcome.text;
    if (outcome.status === "busy") throw new SlackReplyLaneBusy();
    journal(`slack ${scope.requestId}: no answer (${outcome.status})`);
    return null;
  };
}
