import { probeRunnerInputsClock } from "./runner-inputs-clock";
import { probeSchedulerRuntime } from "./scheduler-runtime";
import { probeScheduler } from "./scheduler";
import { probeEpicReconciliation } from "./intake-reconciliation";
import { probePublicationReadiness } from "./publication-readiness";
import { probeExecutionLifecycle } from "./execution-lifecycle";
import { probeExecutionChanges } from "./execution-changes";
import { probePublicationStop } from "./publication-stop";
import { probeMergeDependencyYield } from "./merge-dependency-yield";
import { probeRunnerPlacement } from "./runner-placement";
import { probeRunnerPolicyBrowser } from "./runner-policy-browser";
import { probeExecutionControls } from "./execution-controls";
import { probeExecutionStopStates } from "./execution-stop-states";
import { probeLinearActivityBudget } from "./linear-activity-budget";
import { probeRunnerJournal } from "./runner-journal";
import { probeRunnerDaemonHealth } from "./runner-daemon-health";
import { probeRunnerControlStartup } from "./runner-control-startup";
import { probeRunnerBackend } from "./runner-backend";
import { probeCloseoutCommandRunner } from "./closeout-command-runner";
import { probeRunnerCoordinator } from "./runner-coordinator";
import { probeRunnerHealth } from "./runner-health";
import { probeRunnerResults } from "./runner-results";
import { probeRunnerTranscripts } from "./runner-transcripts";
import { probeRunnerArtifacts } from "./runner-artifacts";
import { probeRunnerWork } from "./runner-work";
import { probeRunnerHttp } from "./runner-http";
import { probeRunnerRepositories } from "./runner-repositories";
import { probeGitCancellation } from "./git-cancellation";
import { writeFileSync } from "node:fs";
import { probeRunnerWorker } from "./runner-worker";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  applyWorkItemEvent,
  claimNextJob,
  completeJob,
  beginImplementRun,
  enterMergeQueue,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  recoverOnStartup,
} from "../../src/db";
import { enqueueVerifiedMerge } from "../../src/loop";
import { probeHostAcp } from "./host-acp";
import { probePublicTls } from "./public-tls";
import { probeDaemonEnrollment, probeRunnerEnrollment } from "./runner-enrollment";
import { probeRunnerTls } from "./runner-tls";
import { probeRunnerCoordinatorData } from "./runner-coordinator-data";
import { probeRunnerEvidenceRelays } from "./runner-evidence-relays";
import { probePublicTlsRenewal } from "./public-tls-renewal";

export async function probeBoundaries(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  await probeScheduler(join(root, "scheduler"), observe);
  await probeSchedulerRuntime(join(root, "scheduler-runtime"), observe);
  for (const result of (await probeRunnerInputsClock(join(root, "runner-inputs-clock")))
    .observations)
    observe(result.name, result.passed, result.observed);
  for (const result of await probeEpicReconciliation(join(root, "epic-reconciliation")))
    observe(result.name, result.passed, result.observed);
  for (const result of await probePublicationReadiness(join(root, "publication-readiness")))
    observe(result.name, result.passed, result.observed);
  await probeExecutionLifecycle(join(root, "execution-lifecycle"), observe);
  await probeExecutionChanges(join(root, "execution-changes"), observe);
  await probePublicationStop(join(root, "publication-stop"), observe);
  await probeMergeDependencyYield(join(root, "merge-dependency-yield"), observe);
  await probeRunnerPlacement(join(root, "runner-placement"), observe);
  await probeRunnerPolicyBrowser(join(root, "runner-policy-browser"), observe);
  for (const result of await probeExecutionControls(join(root, "execution-controls")))
    observe(result.name, result.passed, result.observed);
  for (const result of await probeExecutionStopStates(join(root, "execution-stop-states")))
    observe(result.name, result.passed, result.observed);
  await probeLinearActivityBudget(join(root, "linear-activity-budget"), observe);
  await probeRunnerOrchestration(join(root, "runner-orchestration"), observe);
  await probeHostAcp(root, observe);
  await probeCloseoutCommandRunner(join(root, "closeout-command-runner"), observe);
  await probePublicTls(root, observe);
  await probePublicTlsRenewal(join(root, "public-tls-renewal"), observe);
  await probeRunnerResults(join(root, "runner-results"), observe);
  await probeRunnerBackend(join(root, "runner-backend"), observe);
  await probeRunnerHealth(join(root, "runner-health"), observe);
  await probeRunnerCoordinator(join(root, "runner-coordinator"), observe);
  await probeRunnerControlStartup(join(root, "runner-control-startup"), observe);
  probeRunnerJournal(join(root, "runner-journal"), observe);
  await probeRunnerDaemonHealth(join(root, "runner-daemon-health"), observe);
  await probeRunnerTranscripts(join(root, "runner-transcripts"), observe);
  await probeRunnerArtifacts(join(root, "runner-artifacts"), observe);
  await probeRunnerWork(join(root, "runner-work"), observe);
  await probeRunnerTls(join(root, "runner-tls"), observe);
  await probeRunnerCoordinatorData(join(root, "runner-coordinator-data"), observe);
  await probeRunnerEvidenceRelays(join(root, "runner-evidence-relays"), observe);
  const release = Bun.spawn(
    [
      "/usr/bin/python3",
      "-I",
      "-B",
      join(import.meta.dir, "linux-release-test.py"),
      join(import.meta.dir, "../../deploy/linux/release.py"),
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
  );
  const [releaseOutput, releaseErrors, releaseExit] = await Promise.all([
    new Response(release.stdout).text(),
    new Response(release.stderr).text(),
    release.exited,
  ]);
  writeFileSync(join(root, "linux-release-verification.log"), releaseOutput + releaseErrors);
  observe(
    "signed Linux releases reject invalid signatures and unsafe archives",
    releaseExit === 0,
    {
      exit: releaseExit,
      log: "linux-release-verification.log",
    },
  );
  await probeRunnerEnrollment(join(root, "runner-enrollment"), observe);
  await probeDaemonEnrollment(join(root, "daemon-enrollment"), observe);
  await probeRunnerHttp(join(root, "runner-http"), observe);
  await probeRunnerRepositories(join(root, "runner-repositories"), observe);
  await probeGitCancellation(join(root, "git-cancellation"), observe);
  await probeRunnerWorker(join(root, "runner-worker"), observe);
  const clock = new FakeClock(1000);
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    const checkpoint = {
      phase: "merge_queue" as const,
      baseSha: "a".repeat(40),
      wipCommit: "b".repeat(40),
    };
    const recovering = insertQueuedItem(db, { id: "recovering-item", now: clock.now() });
    beginImplementRun(db, recovering.id, clock.now());
    enterMergeQueue(db, recovering.id, checkpoint);
    const original = enqueueVerifiedMerge(db, {
      itemId: recovering.id,
      head: checkpoint.wipCommit,
      summary: "Accepted synthetic candidate",
      now: clock.now(),
    });
    recoverOnStartup(db, clock.now());
    if (getWorkItem(db, recovering.id)?.state === "verifying")
      applyWorkItemEvent(db, recovering.id, "closeout_accepted");
    const reverification = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.reverify] });
    if (reverification === null) throw new Error("Recovery did not schedule re-verification");
    const retry = enqueueVerifiedMerge(db, {
      itemId: recovering.id,
      head: checkpoint.wipCommit,
      summary: "Reverified synthetic candidate",
      now: clock.now(),
      reverifyJobId: reverification.id,
    });
    completeJob(db, reverification, clock.now());
    const runnable = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    observe(
      "reverified merge schedules a runnable retry",
      runnable?.id === retry && retry !== original,
      {
        original,
        retry,
        claimedRetry: runnable?.id ?? null,
        jobs: listJobs(db).map(({ id, queue, status }) => ({ id, queue, status })),
      },
    );
  } finally {
    db.close();
  }
}
import { probeRunnerOrchestration } from "./runner-orchestration";
