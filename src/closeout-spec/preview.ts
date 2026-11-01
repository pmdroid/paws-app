import type { EvidenceApproval } from "./types";

export type PreviewAcceptInput = {
  task: string;
  checkId: string;
  head: string;
  url: string;
  acceptedBy: string;
  acceptedAt: number;
  via: "paws" | "linear";
  delegatedBy: string | null;
  projectLead: string | null;
};

export type PreviewAccept =
  | { ok: true; approval: EvidenceApproval }
  | { ok: false; reason: string };

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function previewAccept(input: PreviewAcceptInput): PreviewAccept {
  if (input.via !== "paws") return { ok: false, reason: "A Linear reply cannot accept a preview." };
  const allowed = [input.delegatedBy, input.projectLead].filter((id) => id !== null && id !== "");
  if (input.acceptedBy === "" || !allowed.includes(input.acceptedBy))
    return {
      ok: false,
      reason: "Only the delegating member or the project lead can accept a preview.",
    };
  if (!COMMIT.test(input.head)) return { ok: false, reason: "The previewed head is not a commit." };
  if (!httpUrl(input.url)) return { ok: false, reason: "The preview URL is not an http(s) URL." };
  return {
    ok: true,
    approval: {
      task: input.task,
      checkId: input.checkId,
      evidenceIds: [],
      approvedBy: input.acceptedBy,
      approvedAt: new Date(input.acceptedAt).toISOString(),
      commit: input.head,
      url: input.url,
    },
  };
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
