import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync, Visitor } from "oxc-parser";

function emptyCatches(file: string, source: string): number[] {
  const parsed = parseSync(file, source);
  expect(parsed.errors).toEqual([]);
  const offsets: number[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !/SCRIPT$/.test(node.id.name)) return;
      const init = node.init;
      const template = init?.type === "TaggedTemplateExpression" ? init.quasi : init;
      if (template?.type !== "TemplateLiteral" || template.expressions.length !== 0) return;
      const raw = template.quasis[0]?.value.raw;
      if (!raw) return;
      const baseLine = source.slice(0, template.start).split("\n").length - 1;
      for (const line of emptyCatches(`${file}.inline.js`, raw)) {
        const targetLine = baseLine + line;
        let offset = 0;
        for (let index = 1; index < targetLine; index++) offset = source.indexOf("\n", offset) + 1;
        offsets.push(offset);
      }
    },
    CatchClause(node) {
      if (node.body.body.length === 0) offsets.push(node.start);
    },
    CallExpression(node) {
      if (
        node.callee.type !== "MemberExpression" ||
        node.callee.computed ||
        node.callee.property.type !== "Identifier" ||
        node.callee.property.name !== "catch"
      )
        return;
      const callback = node.arguments[0];
      if (
        callback &&
        (callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression") &&
        callback.body?.type === "BlockStatement" &&
        callback.body.body.length === 0
      )
        offsets.push(callback.start);
    },
  }).visit(parsed.program);
  return offsets.map((offset) => source.slice(0, offset).split("\n").length);
}

test("rejects empty and comment-only catch blocks, including promise handlers", () => {
  expect(emptyCatches("example.ts", "try {} catch {} ")).toHaveLength(1);
  expect(emptyCatches("example.ts", "try {} catch (error) { /* ignored */ } ")).toHaveLength(1);
  expect(emptyCatches("example.ts", "task.catch(() => { /* ignored */ });")).toHaveLength(1);
  expect(emptyCatches("example.ts", "task.catch(function (error) {});")).toHaveLength(1);
  expect(emptyCatches("example.ts", "try {} catch (error) { throw error; }")).toEqual([]);
  expect(emptyCatches("example.tsx", '<div>{"catch {}"}</div>')).toEqual([]);
  expect(emptyCatches("example.ts", "const SCRIPT = String.raw`try {} catch {}`;")).toHaveLength(1);
});

test("src contains no empty catches", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const violations: string[] = [];
  for (const file of readdirSync(root, { recursive: true })) {
    if (typeof file !== "string" || !/\.[cm]?[jt]sx?$/.test(file)) continue;

    if (file.startsWith("dashboard/dist/")) continue;
    for (const line of emptyCatches(file, readFileSync(join(root, file), "utf8")))
      violations.push(`${file}:${line}`);
  }
  expect(violations).toEqual([]);
});

const SLEEPS = /\bawait\s+sleep\(|\bBun\.sleep\(/;
const SLEEPING_TESTS = new Set([
  "accepted-candidate.test.ts",
  "app-recovery-attribution.test.ts",
  "candidate-head-replica.test.ts",
  "ci-recheck.test.ts",
  "closeout-evidence-objects.test.ts",
  "closeout-rules-first.test.ts",
  "closeout-session-policy.test.ts",
  "closeout-session.test.ts",
  "closeout-timeout-policy.test.ts",
  "control-lane.test.ts",
  "credential-refresh.test.ts",
  "evidence-resources.test.ts",
  "first-delegation-budget.test.ts",
  "github-delivery-merge.test.ts",
  "github-e2e.test.ts",
  "github-hosted-connect.test.ts",
  "http-request-metrics.test.ts",
  "instances.test.ts",
  "job-workers.test.ts",
  "linear-administration-runtime.test.ts",
  "linear-conversation.test.ts",
  "linear-files.test.ts",
  "linear-ingress-deadline.test.ts",
  "linear-intake-queue.test.ts",
  "linear-intake-replicas.test.ts",
  "linear-lifecycle-budget.test.ts",
  "linear-lifecycle-delivery.test.ts",
  "linear-pagination.test.ts",
  "linear-planner-cleanup.test.ts",
  "linear-poller.test.ts",
  "linear-question-reread.test.ts",
  "linear-quiet-poll.test.ts",
  "linear-repository-routing.test.ts",
  "linear-revoked-classifier-ingress.test.ts",
  "linear-shared-budget.test.ts",
  "linear-stale-session.test.ts",
  "linear-start-budget.test.ts",
  "linear-start-session.test.ts",
  "linear-task-planning.test.ts",
  "linear-task-runtime.test.ts",
  "linear-tracker.test.ts",
  "linear-transport.test.ts",
  "linear-webhook-ack.test.ts",
  "loop-keepalive.test.ts",
  "loop.closeout-stall.test.ts",
  "loop.e2e.test.ts",
  "loop.handover.test.ts",
  "loop.out-of-memory.test.ts",
  "loop.question-resume.test.ts",
  "loop.remote-follow-up.test.ts",
  "loop.visual-review.test.ts",
  "merge-reconcile-retry.test.ts",
  "preflight-cleanup.test.ts",
  "preflight-retries.test.ts",
  "provisioning-bootstrap.test.ts",
  "push-outage.test.ts",
  "recovering-slot-reservation.test.ts",
  "remote-closeout-output.test.ts",
  "restart-activity-keys.test.ts",
  "retro-runner-end-to-end.test.ts",
  "retro-settings-ui.test.ts",
  "rewritten-branch.test.ts",
  "risk-display.test.ts",
  "roles.test.ts",
  "runner-capacity-wait.test.ts",
  "runner-checkout-cleanup.test.ts",
  "runner-cleanup-responsive.test.ts",
  "runner-closeout-restart.test.ts",
  "runner-fault-matrix.test.ts",
  "runner-follow-up.test.ts",
  "runner-github-read.test.ts",
  "runner-host-status.test.ts",
  "runner-offline-authority.test.ts",
  "runner-phantom-reservation.test.ts",
  "runner-placement-race.test.ts",
  "runner-preparation-lane.test.ts",
  "runner-process-cleanup.test.ts",
  "runner-repository-commands.test.ts",
  "runner-repository-rebase.test.ts",
  "runner-reservation-replicas.test.ts",
  "runner-response-task-restart.test.ts",
  "runner-retro-worker.test.ts",
  "runner-runtime-added-repositories.test.ts",
  "runner-runtime-artifact-drop.test.ts",
  "runner-runtime-delivery.test.ts",
  "runner-runtime-failure.test.ts",
  "runner-runtime-grant.test.ts",
  "runner-runtime-inputs.test.ts",
  "runner-runtime-outage.test.ts",
  "runner-runtime-publication.test.ts",
  "runner-runtime-push.test.ts",
  "runner-runtime-resume.test.ts",
  "runner-runtime-runtimes.test.ts",
  "runner-runtime-session.test.ts",
  "runner-runtime.test.ts",
  "runner-session-snapshot.test.ts",
  "runner-setup-hold-queue.test.ts",
  "runner-setup-hold.test.ts",
  "runner-sign-in-checks.test.ts",
  "runner-snapshot-history.test.ts",
  "runner-start-commit.test.ts",
  "runner-storage-report.test.ts",
  "runner-stored-candidate.test.ts",
  "runner-usage-restart.test.ts",
  "server-drain.test.ts",
  "session-scoped-flush.test.ts",
  "shutdown-wip.test.ts",
  "slack-install.test.ts",
  "slack-threads.test.ts",
  "startup-resume-stagger.test.ts",
  "storage-usage.test.ts",
  "transient-faults.test.ts",
  "verify-merge-faults.test.ts",
  "workspace-access-startup.test.ts",
  "workspace-assignments.test.ts",
  "workspace-required.test.ts",
  "workspace-revocation.test.ts",
]);

test("rejects fixed sleeps in test files", () => {
  expect(SLEEPS.test("await Bun.sleep(100);")).toBe(true);
  expect(SLEEPS.test("void Bun.sleep(5);")).toBe(true);
  expect(SLEEPS.test("await sleep(50);")).toBe(true);
  expect(SLEEPS.test("await waitFor(() => done, { timeoutMs: 5_000 });")).toBe(false);
});

test("test files wait for completion signals instead of sleeping", () => {
  const root = new URL("./", import.meta.url).pathname;
  const sleeping: string[] = [];
  for (const file of readdirSync(root, { recursive: true })) {
    if (typeof file !== "string" || !file.endsWith(".test.ts") || file === "empty-catches.test.ts")
      continue;
    if (SLEEPS.test(readFileSync(join(root, file), "utf8"))) sleeping.push(file);
  }
  expect(sleeping.filter((file) => !SLEEPING_TESTS.has(file))).toEqual([]);
  expect([...SLEEPING_TESTS].filter((file) => !sleeping.includes(file))).toEqual([]);
});
