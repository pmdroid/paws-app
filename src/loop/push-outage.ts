import {
  releasePushOutageJobsSteps,
  endPushOutageSteps,
  getJobSteps,
  getPushOutageSteps,
  getWorkItemSteps,
  listPushOutagesSteps,
  parkLeasedJobSteps,
  recordPushOutageSteps,
  setPushOutageQuestionSteps,
  takePushOutageProbeSteps,
  type Db,
  type Q,
  type Steps,
  type Job,
  type PushOutage,
} from "../db";
import { PushOutageError, pushOutageProbeDelayMs } from "../github";
import { journal } from "../journal";
import { cancelQuestionSteps, getQuestionSteps } from "../questions";
import { askSteps } from "./operations";

/** After this long in an outage, Paws asks one workspace question to check the App installation. */
export const PUSH_OUTAGE_QUESTION_MS = 60 * 60_000;
/** A held merge job looks again this often even when no probe wakes it. */
export const PUSH_OUTAGE_HOLD_MS = 60 * 60_000;

/**
 * A push GitHub refused from the Paws App (PAS-867): merge and candidate pushes for that
 * repository wait instead of failing, one merge job probes with backoff, and the first push that
 * works ends the outage and wakes the held jobs in queue order. Items keep their state, and no
 * question opens for any one item.
 */
export function pushOutageBanner(outage: PushOutage): string {
  return `GitHub refuses pushes from the Paws app since ${new Date(outage.startedAt).toISOString()}. Pushes wait and retry.`;
}

/**
 * Throws a held {@link PushOutageError} when `jobId` must not push to `repository` now: another
 * live merge job probes the outage. A job whose probe is gone takes the probe over.
 */
export function* holdPushSteps(q: Q, repository: string, jobId: number | null): Steps<void> {
  const outage = yield* getPushOutageSteps(q, repository);
  if (outage === null || jobId === null || outage.probeJobId === jobId) return;
  if (outage.probeJobId !== null && (yield* jobLiveSteps(q, outage.probeJobId)))
    throw new PushOutageError(["push"], outage.lastError, true);
  yield* takePushOutageProbeSteps(q, repository, jobId);
}

export async function holdPush(store: Db, repository: string, jobId: number | null): Promise<void> {
  await store.transaction((q) => holdPushSteps(q, repository, jobId));
}

/**
 * Records GitHub's refusal of a push from `jobId`. A held push records nothing; it returns the
 * outage that held it, or null when that outage has ended since.
 */
export async function pushRefused(
  store: Db,
  input: {
    repository: string;
    error: PushOutageError;
    jobId: number | null;
    installationUrl: string | null;
    now: number;
  },
): Promise<PushOutage | null> {
  return await store.transaction(function* (q) {
    const current = yield* getPushOutageSteps(q, input.repository);
    if (input.error.held) return current;
    const outage = yield* recordPushOutageSteps(q, {
      repository: input.repository,
      error: scrubTokens(input.error.stderr.trim()).slice(0, 4096),
      jobId: input.jobId,
      installationUrl: input.installationUrl,
      now: input.now,
      delayMs: pushOutageProbeDelayMs,
    });
    if (current === null)
      journal(`push outage on ${input.repository}: ${outage.lastError.split("\n")[0] ?? ""}`);
    return outage;
  });
}

/**
 * Parks a merge job the outage holds without spending an attempt. The probe wakes at its next
 * probe time; every other job waits for the outage to end.
 */
export async function parkForPushOutage(
  store: Db,
  job: Job,
  outage: PushOutage,
  now: number,
): Promise<"parked" | "lost"> {
  const payload =
    typeof job.payload === "object" && job.payload !== null && !Array.isArray(job.payload)
      ? { ...(job.payload as Record<string, unknown>) }
      : {};
  const probe = outage.probeJobId === job.id;
  const message = probe
    ? `${pushOutageBanner(outage)} Next try at ${new Date(outage.nextProbeAt).toISOString()}.`
    : pushOutageBanner(outage);
  const parked = await store.run((q) =>
    parkLeasedJobSteps(q, job, {
      runAt: probe ? outage.nextProbeAt : now + PUSH_OUTAGE_HOLD_MS,
      payload: {
        ...payload,
        pushOutage: outage.repository,
        mergeWait: { reason: "push_outage", message, at: now },
      },
      attempts: job.attempts - 1,
      now,
    }),
  );
  return parked ? "parked" : "lost";
}

/**
 * A push to `repository` worked. Ends its outage, wakes the merge jobs it held so they run in
 * queue order, and closes the workspace question. Returns the outage it ended, or null.
 */
export async function pushWorked(
  store: Db,
  repository: string,
  now: number,
): Promise<PushOutage | null> {
  const ended = await store.transaction(function* (q) {
    const outage = yield* endPushOutageSteps(q, repository);
    if (outage === null) return null;
    yield* releasePushOutageJobsSteps(q, repository, now);
    if (outage.questionId !== null) yield* cancelQuestionSteps(q, outage.questionId, now);
    return outage;
  });
  if (ended) journal(`push outage on ${repository} ended`);
  return ended;
}

/**
 * Asks one question for the workspace once an outage has lasted {@link PUSH_OUTAGE_QUESTION_MS},
 * on the Linear session of the probe's item. The item keeps its state. Nothing is asked while
 * another outage's question is open, or again after a person answered it.
 */
export async function askAboutPushOutage(
  store: Db,
  repository: string,
  now: number,
): Promise<"asked" | "not_yet" | "already" | "no_session"> {
  return await store.transaction(function* (q) {
    const outage = yield* getPushOutageSteps(q, repository);
    if (outage === null || now - outage.startedAt < PUSH_OUTAGE_QUESTION_MS) return "not_yet";
    if (outage.questionId !== null) return "already";
    let open = false;
    for (const entry of yield* listPushOutagesSteps(q)) {
      const question = entry.questionId ? yield* getQuestionSteps(q, entry.questionId) : null;
      if (question?.status === "open" || question?.status === "queued") open = true;
    }
    if (open) return "already";
    const probe = outage.probeJobId === null ? null : yield* getJobSteps(q, outage.probeJobId);
    const itemId =
      probe && typeof (probe.payload as { itemId?: unknown } | null)?.itemId === "string"
        ? (probe.payload as { itemId: string }).itemId
        : null;
    const item = itemId ? yield* getWorkItemSteps(q, itemId) : null;
    if (!item?.sessionKey || item.cancelRequested) return "no_session";
    const asked = yield* askSteps(
      q,
      {
        itemId: item.id,
        runId: item.currentRunId,
        sessionId: item.sessionKey,
        workspace: true,
      },
      "push-outage",
      pushOutageQuestion(outage),
      { reason: "push_outage", now },
    );
    yield* setPushOutageQuestionSteps(q, repository, asked.question.id);
    return "asked";
  });
}

export function pushOutageQuestion(outage: PushOutage): string {
  const since = new Date(outage.startedAt).toISOString();
  const check = outage.installationUrl
    ? `[the Paws App's installation settings](${outage.installationUrl})`
    : "the Paws App's installation settings on GitHub";
  return [
    `GitHub has refused every push from the Paws app to ${outage.repository} since ${since}. Pushes for this workspace wait and retry; no task fails because of it.`,
    `Please check ${check}: its repository access and its Contents permission. This question closes by itself once a push works again.`,
    "Last error from GitHub:",
    "```",
    outage.lastError,
    "```",
  ].join("\n\n");
}

/** The App installation's settings on GitHub, where its permissions and repositories are. */
export function installationSettingsUrl(installationId: string): string {
  return `https://github.com/settings/installations/${encodeURIComponent(installationId)}`;
}

function scrubTokens(text: string): string {
  return text.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]");
}

function* jobLiveSteps(q: Q, jobId: number): Steps<boolean> {
  const job = yield* getJobSteps(q, jobId);
  return job?.status === "pending" || job?.status === "running";
}
