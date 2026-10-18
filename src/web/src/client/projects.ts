import { routeHref } from "./route";
import { esc } from "./format";
import { renderMarkup } from "./theme";

type Issue = {
  linearIssueId: string;
  identifier: string;
  title: string;
  description: string | null;
  stateType: string;
};
type Project = { id: string; name: string; issues: Issue[] };
type Blocker =
  | { blockerLinearIssueId: string; outcome: "completion" }
  | {
      blockerLinearIssueId: string;
      outcome: "merge";
      repository: string;
      targetBranch: string;
      pullRequestNumber: number;
    };
type Selection = {
  projectId: string;
  issueIds: string[];
  repository: string;
  targetBranch: "main";
  leadUserId: string;
  steeringRoles: string[];
  blockers: Blocker[];
};
type Approval = {
  id: string;
  generation: string;
  leadUserId: string;
  pausedAt: number | null;
  stoppedAt: number | null;
  lastError: string | null;
  preview: {
    project: Project;
    selection: Selection;
    includedIssueIds: string[];
    excludedIssueIds: string[];
    order: string[];
    externalBlockerIds: string[];
    problems: string[];
  };
  progress: {
    issueId: string;
    epicId: string | null;
    blockedReasons: string[];
    items: { id: string; state: string; title: string }[];
  }[];
};
type Overview = {
  userId: string;
  approvals: Approval[];
  repositories: { repository: string; teamId: string }[];
  members: { id: string; name: string }[];
};
type Status = "all" | "active" | "attention" | "paused" | "stopped";

const STATUSES: { value: Status; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "attention", label: "Needs attention" },
  { value: "paused", label: "Paused" },
  { value: "stopped", label: "Stopped" },
];

export function createProjects() {
  let root: HTMLElement | null = null;
  let connection = "";
  let available = false;
  let overview: Overview | null = null;
  let project: Project | null = null;
  let preview: Approval | null = null;
  let projectId = "";
  let repository = "";
  let leadUserId = "";
  let steeringRoles = ["owner", "admin"];
  let selected = new Set<string>();
  let blockers: Blocker[] = [];
  let busy = false;
  let error = "";
  let feedback = "";
  let previewCurrent = false;
  let generation = 0;
  let composing = false;
  let composerTouched = false;
  let status: Status = "all";
  let leadFilter = "";
  let repositoryFilter = "";
  let search = "";
  let restoreQueryFocus = false;
  async function api<T>(body?: unknown, query = ""): Promise<T> {
    if (!available) throw new Error("Open your live Paws dashboard to manage projects.");
    const response = await fetch(`/api/projects${query}`, {
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-paws-csrf":
                document.querySelector('meta[name="paws-csrf"]')?.getAttribute("content") ?? "",
            },
            body: JSON.stringify(body),
          }),
    });
    const result = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Project action failed. Try again.");
    return result;
  }
  async function change(operation: () => Promise<void>) {
    if (busy) return;
    const current = generation;
    busy = true;
    error = "";
    paint();
    try {
      await operation();
    } catch (cause) {
      if (current === generation)
        error = cause instanceof Error ? cause.message : "Project action failed.";
    } finally {
      if (current === generation) {
        busy = false;
        paint();
      }
    }
  }
  async function load() {
    const current = generation;
    const result = await api<Overview>();
    if (current !== generation) return;
    overview = result;
    repository ||= result.repositories[0]?.repository ?? "";
    leadUserId ||= result.userId;
    if (!composerTouched && !result.approvals.length) composing = true;
  }
  function readSelection(): Selection {
    const form = root?.querySelector<HTMLFormElement>("#project-selection");
    if (form) {
      const fields = new FormData(form);
      repository = String(fields.get("repository") ?? "");
      leadUserId = String(fields.get("lead") ?? "");
      selected = new Set(fields.getAll("issue").map(String));
      steeringRoles = fields.getAll("steering").map(String);
    }
    return {
      projectId: project!.id,
      issueIds: [...selected],
      repository,
      leadUserId,
      targetBranch: "main",
      steeringRoles,
      blockers,
    };
  }
  function policyFields() {
    return (
      preview?.preview.externalBlockerIds
        .map((id) => {
          const policy = blockers.find((entry) => entry.blockerLinearIssueId === id);
          return `<fieldset class="min-w-0 space-y-3" data-blocker="${esc(id)}"><legend>Blocker ${esc(id)}</legend><label class="field"><span>Required outcome</span><select name="outcome"><option value="merge"${policy?.outcome !== "completion" ? " selected" : ""}>Code merged</option><option value="completion"${policy?.outcome === "completion" ? " selected" : ""}>Answer, artifact or manual completion</option></select></label><div class="grid gap-3 sm:grid-cols-3"><label class="field"><span>GitHub repository</span><input name="repository" value="${esc(policy?.outcome === "merge" ? policy.repository : repository)}" placeholder="owner/repository"></label><label class="field"><span>Target branch</span><input name="branch" value="${esc(policy?.outcome === "merge" ? policy.targetBranch : "main")}"></label><label class="field"><span>Pull request number</span><input name="number" type="number" min="1" value="${policy?.outcome === "merge" && policy.pullRequestNumber > 0 ? policy.pullRequestNumber : ""}"></label></div></fieldset>`;
        })
        .join("") ?? ""
    );
  }
  function readPolicies() {
    blockers = [...(root?.querySelectorAll<HTMLElement>("[data-blocker]") ?? [])].map((entry) => {
      const value = (name: string) =>
        entry
          .querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)
          ?.value.trim() ?? "";
      return value("outcome") === "completion"
        ? { blockerLinearIssueId: entry.dataset["blocker"]!, outcome: "completion" as const }
        : {
            blockerLinearIssueId: entry.dataset["blocker"]!,
            outcome: "merge" as const,
            repository: value("repository"),
            targetBranch: value("branch"),
            pullRequestNumber: Number(value("number")),
          };
    });
  }
  function memberName(id: string) {
    const name = overview?.members.find((member) => member.id === id)?.name ?? "Former member";
    return id === overview?.userId ? `${name} (you)` : name;
  }
  function composer(disabled: string) {
    const names = new Map(project?.issues.map((issue) => [issue.linearIssueId, issue.identifier]));
    const eligible = (issue: Issue) =>
      !["completed", "canceled", "duplicate"].includes(issue.stateType) &&
      Boolean(issue.description?.trim());
    const eligibleCount = project?.issues.filter(eligible).length ?? 0;
    const policyComplete = preview?.preview.externalBlockerIds.every((id) =>
      blockers.some(
        (policy) =>
          policy.blockerLinearIssueId === id &&
          (policy.outcome === "completion" || policy.pullRequestNumber > 0),
      ),
    );
    return `<section id="project-new" class="card space-y-6" aria-labelledby="project-new-title"><div class="space-y-2"><h2 id="project-new-title">Start a project</h2><p class="sub">Paste a Linear project link, choose its issues, then review and approve. Later changes to approved requirements hold delivery until you stop the project and approve it again.</p></div><form id="project-load" class="settings-controls"><label class="field flex-1"><span>Linear project URL or ID</span><input name="project" required value="${esc(projectId)}" autocomplete="off" placeholder="https://linear.app/team/project/…"></label><button class="btn" type="submit"${disabled}>Load project</button></form>${
      project && overview
        ? `<form id="project-selection"><h3>${esc(project.name)}</h3><div class="grid gap-4 sm:grid-cols-2"><label class="field"><span>Repository</span><select name="repository" aria-label="Repository" required>${[...new Set(overview.repositories.map((entry) => entry.repository))].map((name) => `<option${name === repository ? " selected" : ""}>${esc(name)}</option>`).join("")}</select></label><label class="field"><span>Lead</span><select name="lead" aria-label="Lead">${overview.members.map((member) => `<option value="${esc(member.id)}"${member.id === leadUserId ? " selected" : ""}>${esc(member.name)}</option>`).join("")}</select></label></div><p class="sub">Target branch: main. The lead steers execution. Work uses the assignee on each issue and the configured <a href="${routeHref({ view: "runners" })}">runner account policy</a>.</p><fieldset><legend>Who else can steer</legend><div class="row">${["owner", "admin", "member"].map((role) => `<label class="flex min-h-11 items-center gap-3"><input name="steering" type="checkbox" value="${role}"${steeringRoles.includes(role) ? " checked" : ""}><span>${role}</span></label>`).join("")}</div></fieldset><fieldset><legend>Issues to execute</legend><div class="between"><p class="sub" data-selected-count>${selected.size} of ${eligibleCount} ready issues selected</p><div class="row"><button type="button" class="btn" data-project-issues="all"${disabled}>Select all ready</button><button type="button" class="btn" data-project-issues="none"${disabled}>Clear</button></div></div>${project.issues
            .map(
              (issue) =>
                `<label class="flex min-h-11 items-start gap-3"><input name="issue" type="checkbox" value="${esc(issue.linearIssueId)}"${selected.has(issue.linearIssueId) ? " checked" : ""}${!eligible(issue) || busy ? " disabled" : ""}><span><strong>${esc(issue.identifier)}</strong> ${esc(issue.title)}${eligible(issue) ? "" : `<span class="block muted">${issue.description?.trim() ? esc(issue.stateType) : "Add requirements in Linear."}</span>`}</span></label>`,
            )
            .join(
              "",
            )}</fieldset>${policyFields()}<button class="btn" type="submit"${disabled}>Preview selected scope</button></form>`
        : ""
    }${preview ? `<section class="space-y-4" aria-label="Approval preview"><h3>Review ${preview.preview.includedIssueIds.length} issues</h3><p>${preview.preview.excludedIssueIds.length} project issues excluded.</p><ol>${preview.preview.order.map((id) => `<li>${esc(names.get(id) ?? id)}</li>`).join("")}</ol>${preview.preview.problems.map((problem) => `<p class="err">${esc(problem)}</p>`).join("")}${preview.preview.externalBlockerIds.length ? "<p>Confirm each external blocker's required outcome, then preview the scope again.</p>" : ""}<button class="btn primary" data-project-approve${busy || !previewCurrent || preview.preview.problems.length || !policyComplete ? " disabled" : ""}>Approve ${preview.preview.includedIssueIds.length} issues</button></section>` : ""}</section>`;
  }
  function approvedList(disabled: string) {
    const approvals = [...(overview?.approvals ?? [])].sort(
      (a, b) => Number(a.stoppedAt !== null) - Number(b.stoppedAt !== null),
    );
    if (!approvals.length)
      return `<section class="card space-y-4" aria-labelledby="projects-title"><h2 id="projects-title">Projects</h2><p class="empty">No project has been approved yet. Choose New project to approve Linear issues for Paws to deliver.</p></section>`;
    const leads = [...new Set(approvals.map((entry) => entry.leadUserId))].sort((a, b) =>
      a === overview?.userId
        ? -1
        : b === overview?.userId
          ? 1
          : memberName(a).localeCompare(memberName(b)),
    );
    const repositories = [
      ...new Set(approvals.map((entry) => entry.preview.selection.repository).filter(Boolean)),
    ].sort();
    if (leadFilter && !leads.includes(leadFilter)) leadFilter = "";
    if (repositoryFilter && !repositories.includes(repositoryFilter)) repositoryFilter = "";
    const needle = search.trim().toLowerCase();
    const scoped = approvals.filter(
      (entry) =>
        (!leadFilter || entry.leadUserId === leadFilter) &&
        (!repositoryFilter || entry.preview.selection.repository === repositoryFilter) &&
        (!needle ||
          [
            entry.preview.project.name,
            entry.preview.selection.repository,
            ...entry.preview.project.issues.map((issue) => `${issue.identifier} ${issue.title}`),
          ].some((text) => text.toLowerCase().includes(needle))),
    );
    const counts = new Map(
      STATUSES.map((entry) => [
        entry.value,
        scoped.filter((approval) => matchesStatus(approval, entry.value)).length,
      ]),
    );
    const visible = scoped.filter((entry) => matchesStatus(entry, status));
    const filtered = Boolean(leadFilter || repositoryFilter || needle || status !== "all");
    return `<section class="card space-y-6" aria-labelledby="projects-title"><div class="between"><h2 id="projects-title">Projects</h2><p class="sub" role="status">${visible.length === approvals.length ? `${approvals.length} ${approvals.length === 1 ? "project" : "projects"}` : `Showing ${visible.length} of ${approvals.length}`}</p></div><div class="settings-controls" role="search" aria-label="Filter projects"><label class="field"><span>Search</span><input type="search" name="project-query" value="${esc(search)}" placeholder="Project, issue or repository" autocomplete="off"></label><label class="field"><span>Lead</span><select name="project-lead" aria-label="Filter by lead"><option value=""${leadFilter ? "" : " selected"}>Any lead</option>${leads.map((id) => `<option value="${esc(id)}"${id === leadFilter ? " selected" : ""}>${esc(memberName(id))}</option>`).join("")}</select></label>${repositories.length > 1 ? `<label class="field"><span>Repository</span><select name="project-repository" aria-label="Filter by repository"><option value=""${repositoryFilter ? "" : " selected"}>Any repository</option>${repositories.map((name) => `<option value="${esc(name)}"${name === repositoryFilter ? " selected" : ""}>${esc(name)}</option>`).join("")}</select></label>` : ""}</div><div class="between"><div class="issue-filters" role="group" aria-label="Filter by status">${STATUSES.map((entry) => `<button type="button" class="btn${entry.value === status ? " on" : ""}" data-project-status="${entry.value}" aria-pressed="${entry.value === status}"${disabled}>${entry.label} <span class="cnt">${counts.get(entry.value) ?? 0}</span></button>`).join("")}</div>${filtered ? `<button type="button" class="btn" data-project-clear${disabled}>Clear filters</button>` : ""}</div>${
      visible.length
        ? `<ul class="issue-list">${visible.map((entry) => approvalRow(entry, disabled)).join("")}</ul>`
        : `<p class="empty">No projects match these filters. Clear filters to see all ${approvals.length}.</p>`
    }</section>`;
  }
  function approvalRow(entry: Approval, disabled: string) {
    const delivered = entry.progress.filter(
      (claim) =>
        claim.items.length > 0 &&
        claim.items.every((item) => ["merged", "completed"].includes(item.state)),
    ).length;
    const state =
      entry.stoppedAt !== null
        ? `<span class="pill">Stopped</span>`
        : entry.pausedAt !== null
          ? `<span class="pill paused">Paused</span>`
          : `<span class="pill ok">Active</span>`;
    return `<li class="space-y-3"><div class="between"><h3>${esc(entry.preview.project.name)}</h3><div class="row">${entry.lastError && entry.stoppedAt === null ? `<span class="pill err">Needs attention</span>` : ""}${state}</div></div><p class="sub">${esc(entry.preview.selection.repository || "Parent issue")} · Lead ${esc(memberName(entry.leadUserId))} · ${delivered} of ${entry.preview.includedIssueIds.length} issues delivered</p>${entry.lastError ? `<p role="status">${esc(entry.lastError)}</p>` : ""}<ul>${entry.progress
      .map((claim) => {
        const identifier =
          entry.preview.project.issues.find((issue) => issue.linearIssueId === claim.issueId)
            ?.identifier ?? claim.issueId;
        return `<li>${esc(identifier)}: ${claim.items.length ? claim.items.map((item) => `<a href="${routeHref({ view: "issues", id: identifier })}">${esc(stateLabel(item.state))}</a>`).join(", ") : "Waiting for intake"}${claim.blockedReasons.map((reason) => `<p class="muted">${esc(reason)}</p>`).join("")}</li>`;
      })
      .join(
        "",
      )}</ul>${entry.stoppedAt === null ? `<div class="row"><button class="btn" data-project-control="${esc(entry.id)}" data-control="${entry.pausedAt === null ? "pause" : "resume"}"${disabled}>${entry.pausedAt === null ? "Pause" : "Resume"}</button><details><summary>Stop project</summary><p>Stop unfinished work in this approved scope.</p><button class="btn" data-project-control="${esc(entry.id)}" data-control="stop"${disabled}>Confirm stop</button></details></div>` : ""}</li>`;
  }
  function paint() {
    if (!root) return;
    if (!available) {
      renderMarkup(
        root,
        '<h1 class="sr-only">Projects</h1><p>Open your live Paws dashboard to approve Linear projects.</p>',
      );
      return;
    }
    const disabled = busy ? " disabled" : "";
    renderMarkup(
      root,
      `<h1 class="sr-only">Projects</h1><div class="between"><p class="sub">Approve Linear issues for Paws to deliver, then follow their progress.</p><div class="row"><button class="btn" data-project-refresh${disabled}>Refresh projects</button><button class="btn primary" data-project-new aria-expanded="${composing}" aria-controls="project-new"${disabled}>${composing ? "Close new project" : "New project"}</button></div></div>${error ? `<p role="alert" class="err">${esc(error)}</p>` : ""}<p role="status">${busy ? "Checking project scope…" : esc(feedback)}</p>${composing ? composer(disabled) : ""}${overview && (overview.approvals.length || !composing) ? approvedList(disabled) : ""}`,
    );
    if (busy)
      for (const control of root.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >("input,select,button"))
        control.disabled = true;
    if (restoreQueryFocus) {
      restoreQueryFocus = false;
      const input = root.querySelector<HTMLInputElement>('input[name="project-query"]');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
    root
      .querySelector("[data-project-refresh]")
      ?.addEventListener("click", () => void change(load));
    root.querySelector("[data-project-new]")?.addEventListener("click", () => {
      composing = !composing;
      composerTouched = true;
      paint();
      if (composing) root?.querySelector<HTMLInputElement>('input[name="project"]')?.focus();
    });
    root
      .querySelector<HTMLInputElement>('input[name="project-query"]')
      ?.addEventListener("input", (event) => {
        search = (event.currentTarget as HTMLInputElement).value;
        restoreQueryFocus = true;
        paint();
      });
    root
      .querySelector<HTMLSelectElement>('select[name="project-lead"]')
      ?.addEventListener("change", (event) => {
        leadFilter = (event.currentTarget as HTMLSelectElement).value;
        paint();
      });
    root
      .querySelector<HTMLSelectElement>('select[name="project-repository"]')
      ?.addEventListener("change", (event) => {
        repositoryFilter = (event.currentTarget as HTMLSelectElement).value;
        paint();
      });
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-project-status]"))
      button.addEventListener("click", () => {
        status = button.dataset["projectStatus"] as Status;
        paint();
      });
    root.querySelector("[data-project-clear]")?.addEventListener("click", () => {
      status = "all";
      leadFilter = "";
      repositoryFilter = "";
      search = "";
      paint();
    });
    root.querySelector<HTMLFormElement>("#project-load")?.addEventListener("submit", (event) => {
      event.preventDefault();
      projectId = String(
        new FormData(event.currentTarget as HTMLFormElement).get("project"),
      ).trim();
      void change(async () => {
        const current = generation;
        const loaded = await api<{ project: Project }>(
          undefined,
          `?projectId=${encodeURIComponent(projectId)}`,
        );
        if (current !== generation) return;
        project = loaded.project;
        selected.clear();
        preview = null;
        blockers = [];
      });
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-project-issues]"))
      button.addEventListener("click", () => {
        readPolicies();
        readSelection();
        selected = new Set(
          button.dataset["projectIssues"] === "all"
            ? [
                ...(root?.querySelectorAll<HTMLInputElement>(
                  'input[name="issue"]:not(:disabled)',
                ) ?? []),
              ].map((input) => input.value)
            : [],
        );
        previewCurrent = false;
        paint();
      });
    root.querySelector<HTMLFormElement>("#project-selection")?.addEventListener("change", () => {
      readPolicies();
      readSelection();
      previewCurrent = false;
      const button = root?.querySelector<HTMLButtonElement>("[data-project-approve]");
      if (button) button.disabled = true;
      const count = root?.querySelector("[data-selected-count]");
      const ready = root?.querySelectorAll('input[name="issue"]:not(:disabled)').length ?? 0;
      if (count) count.textContent = `${selected.size} of ${ready} ready issues selected`;
    });
    root
      .querySelector<HTMLFormElement>("#project-selection")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        readPolicies();
        const selection = readSelection();
        void change(async () => {
          const current = generation;
          const result = await api<{ approval: Approval }>({ action: "preview", selection });
          if (current !== generation) return;
          preview = result.approval;
          previewCurrent = true;
        });
      });
    root.querySelector("[data-project-approve]")?.addEventListener(
      "click",
      () =>
        void change(async () => {
          await api({ action: "approve", id: preview!.id, generation: preview!.generation });
          preview = null;
          project = null;
          projectId = "";
          selected.clear();
          blockers = [];
          composing = false;
          composerTouched = true;
          feedback = "Scope approved. Paws will start the selected issues as dependencies allow.";
          await load();
        }),
    );
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-project-control]"))
      button.addEventListener(
        "click",
        () =>
          void change(async () => {
            await api({ action: button.dataset["control"], id: button.dataset["projectControl"] });
            feedback = "Project control applied.";
            await load();
          }),
      );
  }
  return {
    mount(element: HTMLElement, engine: string | null, source: string | undefined) {
      const key = `${engine}:${source}`;
      if (root === element && connection === key) return;
      root = element;
      if (connection !== key) {
        generation++;
        connection = key;
        overview = null;
        project = null;
        preview = null;
        busy = false;
        status = "all";
        leadFilter = "";
        repositoryFilter = "";
        search = "";
      }
      available =
        engine !== null && new URL(engine).origin === location.origin && source === "live";
      paint();
      if (available && !overview) void change(load);
    },
    refresh: () => change(load),
  };
}

function stateLabel(state: string): string {
  const words = state.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function matchesStatus(entry: Approval, status: Status): boolean {
  if (status === "all") return true;
  if (status === "stopped") return entry.stoppedAt !== null;
  if (entry.stoppedAt !== null) return false;
  if (status === "attention") return entry.lastError !== null;
  return status === "paused" ? entry.pausedAt !== null : entry.pausedAt === null;
}
