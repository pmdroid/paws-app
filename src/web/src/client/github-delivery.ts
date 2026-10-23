import { ago } from "./format";

export type GitHubDelivery = { event: string; receivedAt: number } | null;

export function githubDeliveryLine(delivery: GitHubDelivery | undefined, now = Date.now()): string {
  if (delivery === undefined) return "";
  if (delivery === null) return " No GitHub webhook has arrived yet.";
  const when = ago(new Date(delivery.receivedAt).toISOString(), new Date(now).toISOString());
  return ` Last GitHub webhook: ${delivery.event}, ${when}.`;
}
