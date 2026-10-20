import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OnboardingVmPanel,
  provisionedRunner,
  readOnboardingVm,
  VmAgentSignIn,
  type OnboardingVm,
} from "./onboarding-vm";

const base: OnboardingVm = {
  revision: 3,
  state: "provisioning",
  ready: false,
  detail: "Paws is setting up your VM.",
  machine: { name: "paws-member-1", reused: false },
  steps: [
    { name: "create", state: "done", detail: "Created" },
    { name: "install", state: "running", detail: "Installing the runner" },
    { name: "pair", state: "waiting", detail: "" },
    { name: "health", state: "waiting", detail: "" },
  ],
  retry: null,
  runner: null,
};

function html(vm: OnboardingVm) {
  return renderToStaticMarkup(
    <OnboardingVmPanel
      vm={vm}
      context={{ session: "session", generation: 0 }}
      onVm={() => {}}
      onStale={() => {}}
    />,
  );
}

test("the server projection is accepted only in its exact shape", () => {
  expect(readOnboardingVm(base)).toEqual(base);
  expect(readOnboardingVm({ ...base, revision: -1 })).toBeNull();
  expect(readOnboardingVm({ ...base, ready: "true" })).toBeNull();
  expect(readOnboardingVm({ ...base, state: "done" })).toBeNull();
  expect(readOnboardingVm({ ...base, state: "choice_required" })).toBeNull();
  expect(readOnboardingVm({ ...base, state: "not_linked" })).toBeNull();
  expect(readOnboardingVm({ ...base, runner: { id: 1, name: "x" } })).toBeNull();
  expect(readOnboardingVm({ ...base, retry: "clone" })).toBeNull();
  expect(
    readOnboardingVm({ ...base, steps: [{ name: "install", state: "50%", detail: "" }] }),
  ).toBeNull();
  expect(readOnboardingVm({ ...base, machine: { name: "x" } })).toBeNull();
  expect(readOnboardingVm(null)).toBeNull();
});

const noChooser = (markup: string) => {
  for (const absent of [
    "<select",
    "aria-expanded",
    "Use a runner I paired instead",
    "Keep my automatic VM",
    "paired runner",
    "Choose a runner",
  ])
    expect(markup).not.toContain(absent);
};

test("automatic progress shows each server step and offers no runner choice", () => {
  const markup = html(base);
  expect(markup).toContain("Create your VM on exe.dev");
  expect(markup).toContain("Installing the runner");
  expect(markup).toContain("In progress");
  expect(markup).not.toContain("%");
  expect(markup).not.toContain("Retry");
  noChooser(markup);
});

test("a failed step offers retry for that step and a reused VM keeps its name", () => {
  const markup = html({
    ...base,
    state: "failed",
    machine: { name: "paws-member-1", reused: true },
    steps: base.steps.map((entry) =>
      entry.name === "install" ? { ...entry, state: "failed", detail: "Install failed" } : entry,
    ),
    retry: "install",
  });
  expect(markup).toContain("Retry install");
  expect(markup).toContain("paws-member-1");
  expect(markup).toContain("reused from your earlier setup");
  noChooser(markup);
});

test("unavailable provisioning explains itself without a runner choice", () => {
  const markup = html({
    ...base,
    state: "unavailable",
    detail: "Automatic VM setup is not configured.",
    machine: null,
    steps: [],
  });
  expect(markup).not.toContain("Retry");
  noChooser(markup);
});

const member = { id: "01AAAAAAAAAAAAAAAAAAAAAAAA", name: "paws-member-1" };
const provisioned: OnboardingVm = {
  ...base,
  state: "ready",
  ready: true,
  steps: base.steps.map((entry) => ({ ...entry, state: "done" })),
  runner: member,
};

test("a returning member sees the reused automatic VM and no runner choice", () => {
  const markup = html({ ...provisioned, machine: { name: "paws-member-1", reused: true } });
  expect(markup).toContain("VM paws-member-1");
  expect(markup).toContain("reused from your earlier setup");
  expect(markup).not.toContain("Retry");
  noChooser(markup);
});

test("agent sign-in waits for every provisioning step and the server ready flag", () => {
  expect(provisionedRunner(provisioned)).toEqual(member);
  expect(provisionedRunner({ ...base, runner: member })).toBeNull();
  expect(provisionedRunner({ ...provisioned, ready: false })).toBeNull();
  expect(provisionedRunner({ ...provisioned, state: "provisioning" })).toBeNull();
  expect(provisionedRunner({ ...provisioned, runner: null })).toBeNull();
  expect(
    provisionedRunner({
      ...provisioned,
      steps: provisioned.steps.filter((entry) => entry.name !== "health"),
    }),
  ).toBeNull();
  expect(
    provisionedRunner({
      ...provisioned,
      state: "failed",
      ready: false,
      retry: "health",
      steps: provisioned.steps.map((entry) =>
        entry.name === "health" ? { ...entry, state: "failed" } : entry,
      ),
    }),
  ).toBeNull();
  expect(provisionedRunner({ ...provisioned, steps: [], machine: null })).toBeNull();
  expect(
    provisionedRunner({
      ...provisioned,
      steps: [...provisioned.steps.slice(0, 3), provisioned.steps[0]!],
    }),
  ).toBeNull();
});

test("inherited object keys are not step names or step states", () => {
  for (const name of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
    const steps = base.steps.map((entry) => (entry.name === "pair" ? { ...entry, name } : entry));
    expect(readOnboardingVm({ ...base, steps })).toBeNull();
    expect(readOnboardingVm({ ...base, retry: name })).toBeNull();
    expect(
      readOnboardingVm({
        ...base,
        steps: base.steps.map((entry) =>
          entry.name === "pair" ? { ...entry, state: name } : entry,
        ),
      }),
    ).toBeNull();
  }
  expect(
    readOnboardingVm(
      JSON.parse(JSON.stringify(base).replace('"name":"health"', '"name":"__proto__"')),
    ),
  ).toBeNull();
});

test("steps are unique and a ready projection carries all four with its runner", () => {
  expect(readOnboardingVm(provisioned)).toEqual(provisioned);
  expect(
    readOnboardingVm({ ...base, steps: [...base.steps.slice(0, 3), base.steps[1]!] }),
  ).toBeNull();
  expect(readOnboardingVm({ ...base, steps: [...base.steps, base.steps[0]!] })).toBeNull();
  expect(
    readOnboardingVm({
      ...provisioned,
      steps: [...provisioned.steps.slice(0, 3), provisioned.steps[0]!],
    }),
  ).toBeNull();
  expect(readOnboardingVm({ ...provisioned, steps: provisioned.steps.slice(0, 3) })).toBeNull();
  expect(readOnboardingVm({ ...provisioned, steps: [] })).toBeNull();
  expect(readOnboardingVm({ ...provisioned, runner: null })).toBeNull();
  expect(readOnboardingVm({ ...provisioned, retry: "health" })).toBeNull();
  expect(
    readOnboardingVm({
      ...provisioned,
      steps: provisioned.steps.map((entry) =>
        entry.name === "health" ? { ...entry, state: "running" } : entry,
      ),
    }),
  ).toBeNull();
  expect(readOnboardingVm({ ...provisioned, ready: false })).toBeNull();
  expect(readOnboardingVm({ ...base, ready: true })).toBeNull();
});

test("no Claude or Codex sign-in renders before the VM passes its health check", () => {
  const health = (state: OnboardingVm["steps"][number]["state"]) => ({
    ...base,
    runner: member,
    steps: provisioned.steps.map((entry) =>
      entry.name === "health" ? { ...entry, state } : entry,
    ),
  });
  for (const vm of [
    base,
    health("running"),
    { ...health("failed"), state: "failed" as const, retry: "health" as const },
  ]) {
    expect(readOnboardingVm(vm)).toEqual(vm);
    const markup = renderToStaticMarkup(<VmAgentSignIn vm={vm} />);
    expect(markup).toContain("Once your VM is ready, sign in to Claude and Codex.");
    expect(markup).not.toContain("Sign in to Claude");
    expect(markup).not.toContain("Sign in to Codex");
    expect(markup).not.toContain("Your agent accounts");
  }
});
