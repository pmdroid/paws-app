import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import { OnboardingAgents } from "./onboarding-agents";
import { Button } from "./ui/button";

const STEPS = {
  create: "Create your VM on exe.dev",
  install: "Install tools and the Paws runner",
  pair: "Pair the runner with Paws",
  health: "Check host health",
} as const;
const RETRY = {
  create: "Retry VM creation",
  install: "Retry install",
  pair: "Retry pairing",
  health: "Retry health check",
} as const;
const STEP_STATES = {
  waiting: "Not started",
  running: "In progress",
  done: "Done",
  failed: "Failed",
} as const;
const STEP_NAMES = ["create", "install", "pair", "health"] as const;
const STEP_STATE_NAMES = ["waiting", "running", "done", "failed"] as const;
const VM_STATES = ["unavailable", "provisioning", "failed", "ready"] as const;

type StepName = (typeof STEP_NAMES)[number];
type Runner = { id: string; name: string };
export type OnboardingVm = {
  revision: number;
  state: (typeof VM_STATES)[number];
  ready: boolean;
  detail: string;
  machine: { name: string; reused: boolean } | null;
  steps: { name: StepName; state: (typeof STEP_STATE_NAMES)[number]; detail: string }[];
  retry: StepName | null;
  runner: Runner | null;
};
export type OnboardingContext = { session: string; generation: number };

const text = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length <= max;
const runner = (value: unknown): value is Runner =>
  !!value &&
  typeof value === "object" &&
  "id" in value &&
  "name" in value &&
  text(value.id, 64) &&
  text(value.name, 128);
const member = <T,>(values: readonly T[], value: unknown): value is T =>
  values.some((entry) => entry === value);

function complete(vm: OnboardingVm) {
  return (
    vm.steps.length === STEP_NAMES.length &&
    STEP_NAMES.every((name) => vm.steps.some((entry) => entry.name === name))
  );
}

export function readOnboardingVm(value: unknown): OnboardingVm | null {
  if (!value || typeof value !== "object") return null;
  const vm = value as Record<string, unknown>;
  const machine = vm.machine as Record<string, unknown> | null;
  const steps = vm.steps;
  if (
    typeof vm.revision !== "number" ||
    !Number.isSafeInteger(vm.revision) ||
    vm.revision < 0 ||
    !member(VM_STATES, vm.state) ||
    typeof vm.ready !== "boolean" ||
    !text(vm.detail) ||
    (machine !== null &&
      (typeof machine !== "object" ||
        !text(machine.name, 128) ||
        typeof machine.reused !== "boolean")) ||
    !Array.isArray(steps) ||
    !steps.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        member(STEP_NAMES, entry.name) &&
        member(STEP_STATE_NAMES, entry.state) &&
        text(entry.detail),
    ) ||
    new Set(steps.map((entry) => entry.name)).size !== steps.length ||
    (vm.retry !== null && !member(STEP_NAMES, vm.retry)) ||
    (vm.runner !== null && !runner(vm.runner))
  )
    return null;
  const parsed = value as OnboardingVm;
  if (
    parsed.ready !== (parsed.state === "ready") ||
    (parsed.state === "ready" &&
      (parsed.runner === null ||
        parsed.retry !== null ||
        !complete(parsed) ||
        parsed.steps.some((entry) => entry.state !== "done")))
  )
    return null;
  return parsed;
}

export function provisionedRunner(vm: OnboardingVm): Runner | null {
  return vm.ready &&
    vm.state === "ready" &&
    vm.retry === null &&
    complete(vm) &&
    vm.steps.every((entry) => entry.state === "done")
    ? vm.runner
    : null;
}

export function VmAgentSignIn({ vm }: { vm: OnboardingVm }) {
  const healthy = provisionedRunner(vm);
  return healthy ? (
    <OnboardingAgents key={`${healthy.id}:${vm.machine?.name ?? ""}`} runnerId={healthy.id} />
  ) : (
    <p className="text-sm" role="status">
      Once your VM is ready, sign in to Claude and Codex.
    </p>
  );
}

async function send(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<OnboardingVm> {
  const session = await fetch("/api/auth/session", { cache: "no-store", signal });
  if (!session.ok) throw new Error();
  const auth: { csrfToken?: string } = await session.json();
  if (!auth.csrfToken) throw new Error();
  const response = await fetch(path, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "X-Paws-CSRF": auth.csrfToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error();
  const vm = readOnboardingVm(await response.json());
  if (!vm) throw new Error();
  return vm;
}

function StepIcon({ state }: { state: OnboardingVm["steps"][number]["state"] }) {
  const Icon =
    state === "done"
      ? CircleCheck
      : state === "failed"
        ? CircleAlert
        : state === "running"
          ? LoaderCircle
          : CircleDashed;
  return (
    <Icon
      aria-hidden="true"
      size={20}
      className={`mt-0.5 shrink-0 ${state === "running" ? "animate-spin" : ""}`}
    />
  );
}

export function OnboardingVmPanel({
  vm,
  context,
  onVm,
  onStale,
}: {
  vm: OnboardingVm;
  context: OnboardingContext;
  onVm: (vm: OnboardingVm) => void;
  onStale: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function retry(step: StepName) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = await send(
        "/api/workspaces/onboarding/vm/retry",
        { ...context, revision: vm.revision, step },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      onVm(next);
    } catch {
      if (controller.signal.aborted) return;
      setError("Paws could not retry this step. Refresh onboarding and try again.");
      onStale();
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const failed = vm.steps.find((entry) => entry.name === vm.retry && entry.state === "failed");
  return (
    <div className="space-y-4 pt-2">
      {vm.machine && (
        <p className="text-sm">
          <span className="font-semibold">VM {vm.machine.name}</span>
          {vm.machine.reused && " · reused from your earlier setup"}
        </p>
      )}
      {vm.steps.length > 0 && (
        <ol aria-label="VM setup progress" className="space-y-3">
          {vm.steps.map((entry) => (
            <li key={entry.name} className="flex items-start gap-3">
              <StepIcon state={entry.state} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-x-3">
                  <span className="min-w-0 text-sm font-semibold">{STEPS[entry.name]}</span>
                  <span className="shrink-0 text-sm">{STEP_STATES[entry.state]}</span>
                </div>
                {entry.detail && entry.state !== "waiting" && (
                  <p className="max-w-[60ch] break-words text-sm leading-6">{entry.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {failed && (
        <Button disabled={busy} onClick={() => void retry(failed.name)}>
          {busy ? "Retrying…" : RETRY[failed.name]}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
