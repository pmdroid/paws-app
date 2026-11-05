import { journalCaught } from "../journal";
import { esc } from "./format";
import { loadWhenShown } from "./settings-loads";
import { renderMarkup } from "./theme";

export type WorkspaceMemberRow = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  active: number;
  revokedAt: number | null;
  revokedBy: string | null;
  revokedByName: string | null;
  lastSignInAt: number | null;
  runners: number;
  openItems: number;
};

export type MemberFilter = "all" | "active" | "revoked";

const FILTERS: [MemberFilter, string][] = [
  ["all", "All"],
  ["active", "Active"],
  ["revoked", "Revoked"],
];

const LAST_ADMIN = "The workspace must keep an active admin.";

export const ASK_AN_ADMIN = "Ask an admin to change members or roles.";

function memberStatus(member: WorkspaceMemberRow): "active" | "revoked" | "inactive" {
  if (member.revokedAt !== null) return "revoked";
  return member.active ? "active" : "inactive";
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function time(at: number): string {
  const date = new Date(at);
  return `<time datetime="${date.toISOString()}">${esc(date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}</time>`;
}

export function membersTableMarkup(
  members: readonly WorkspaceMemberRow[],
  input: { userId: string; filter: MemberFilter },
): string {
  const usableAdmins = members.filter(
    (member) => member.role === "admin" && memberStatus(member) === "active",
  ).length;
  const shown = members.filter(
    (member) => input.filter === "all" || memberStatus(member) === input.filter,
  );
  if (shown.length === 0)
    return `<p class="muted">${input.filter === "revoked" ? "No member has revoked access." : "No members match this filter."}</p>`;
  const rows = shown.map((member) => {
    const status = memberStatus(member);
    const lastAdmin = member.role === "admin" && status === "active" && usableAdmins <= 1;
    const reasonId = `member-reason-${esc(member.id)}`;
    const statusCell =
      status === "revoked"
        ? `<span class="pill err">Revoked</span><span class="muted">by ${esc(member.revokedByName ?? member.revokedBy ?? "an admin")} · ${time(member.revokedAt!)}</span>`
        : status === "inactive"
          ? '<span class="pill warn">Not in Linear</span>'
          : '<span class="pill ok">Active</span>';
    const roleDisabled = status !== "active" || lastAdmin;
    const roleSelect = `<label><span class="sr-only">Role for ${esc(member.name)}</span><select class="min-w-32" data-member-role="${esc(member.id)}"${roleDisabled ? " disabled" : ""}${lastAdmin ? ` aria-describedby="${reasonId}"` : ""}>${(
      [
        ["admin", "Admin"],
        ["member", "Member"],
      ] as const
    )
      .map(
        ([role, label]) =>
          `<option value="${role}"${role === member.role ? " selected" : ""}>${label}</option>`,
      )
      .join("")}</select></label>`;
    const action =
      status === "revoked"
        ? `<button class="btn" type="button" data-member-restore="${esc(member.id)}">Restore access</button>`
        : member.id === input.userId
          ? ""
          : `<button class="btn" type="button" data-member-revoke="${esc(member.id)}"${lastAdmin ? ` disabled aria-describedby="${reasonId}"` : ""}>Revoke access</button>`;
    const reason = lastAdmin
      ? `<span class="muted" id="${reasonId}" data-member-reason>${LAST_ADMIN}</span>`
      : "";
    return `<tr data-member="${esc(member.id)}"><td><div class="flex min-w-0 flex-col"><strong>${esc(member.name)}${member.id === input.userId ? ' <span class="muted">(you)</span>' : ""}</strong><span class="muted">${esc(member.email)}</span></div></td><td>${roleSelect}</td><td><div class="flex min-w-0 flex-col items-start gap-1">${statusCell}</div></td><td>${member.lastSignInAt === null ? '<span class="muted">Never</span>' : time(member.lastSignInAt)}</td><td>${member.runners}</td><td>${member.openItems}</td><td><div class="flex min-w-0 flex-col items-start gap-1">${action}${reason}</div></td></tr>`;
  });
  return `<table tabindex="0" aria-label="Workspace members" class="members-table"><thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last sign-in</th><th scope="col">Runners</th><th scope="col">Open items</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

export function revokeDialogMarkup(member: WorkspaceMemberRow): string {
  return `<dialog aria-labelledby="member-revoke-heading" data-member-dialog><form method="dialog" class="dialog-body"><h2 id="member-revoke-heading">Revoke access for ${esc(member.name)}?</h2><p>This cuts off ${esc(member.name)} now:</p><ul class="list-disc space-y-1 pl-6"><li>Signed out of Paws now.</li><li>${count(member.runners, "runner")} revoked.</li><li>${count(member.openItems, "open item")} stopped.</li><li>Can't sign in or delegate to Paws again until an admin restores access.</li></ul><div class="dialog-actions"><button class="btn" type="submit" value="cancel">Cancel</button><button class="btn primary" type="submit" value="revoke" data-member-confirm>Revoke access</button></div></form></dialog>`;
}

export function initializeWorkspaceMembers(
  root: HTMLElement,
  session: { userId?: string; role: string; csrfToken: string },
): void {
  const section = document.createElement("section");
  section.dataset.settingsPage = "members";
  root.append(section);
  if (session.role !== "admin") {
    renderMarkup(section, `<p class="sub">${ASK_AN_ADMIN}</p>`);
    return;
  }
  renderMarkup(
    section,
    `<div class="between"><div class="row" role="group" aria-label="Show members">${FILTERS.map(([filter, label]) => `<button class="btn" type="button" data-member-filter="${filter}" aria-pressed="${filter === "all"}">${label}</button>`).join("")}</div><button class="btn" type="button" data-members-refresh>Refresh members</button></div><p class="empty:hidden" role="status" data-members-feedback></p><div data-members-table></div><div data-members-dialog></div>`,
  );
  const table = section.querySelector<HTMLElement>("[data-members-table]")!;
  const feedback = section.querySelector<HTMLElement>("[data-members-feedback]")!;
  const dialogHost = section.querySelector<HTMLElement>("[data-members-dialog]")!;
  const refresh = section.querySelector<HTMLButtonElement>("[data-members-refresh]")!;
  let members: WorkspaceMemberRow[] = [];
  let filter: MemberFilter = "all";
  let busy = false;

  function render() {
    renderMarkup(table, membersTableMarkup(members, { userId: session.userId ?? "", filter }));
    for (const button of section.querySelectorAll<HTMLButtonElement>("[data-member-filter]"))
      button.setAttribute("aria-pressed", String(button.dataset.memberFilter === filter));
  }

  async function load() {
    refresh.disabled = true;
    try {
      const response = await fetch("/api/workspaces/members", { cache: "no-store" });
      if (!response.ok)
        throw new Error("Members could not be loaded. Refresh members to try again.");
      members = ((await response.json()) as { members: WorkspaceMemberRow[] }).members;
      render();
    } catch (error) {
      journalCaught(error, "workspace-members.load.fetch", null);
      feedback.textContent =
        error instanceof Error ? error.message : "Members could not be loaded.";
    } finally {
      refresh.disabled = false;
    }
  }

  async function change(body: Record<string, unknown>, done: string) {
    if (busy) return;
    busy = true;
    feedback.textContent = "Saving…";
    try {
      const response = await fetch("/api/workspaces/members", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-paws-csrf": session.csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = (await response.json().catch((error) => {
          journalCaught(error, "workspace-members.change.json", null);
          return null;
        })) as { error?: string } | null;
        throw new Error(data?.error ?? "The change could not be saved. Try again.");
      }
      feedback.textContent = done;
    } catch (error) {
      journalCaught(error, "workspace-members.change.fetch", null);
      feedback.textContent =
        error instanceof Error ? error.message : "The change could not be saved.";
    } finally {
      busy = false;
      await load();
    }
  }

  function confirmRevoke(member: WorkspaceMemberRow) {
    renderMarkup(dialogHost, revokeDialogMarkup(member));
    const dialog = dialogHost.querySelector<HTMLDialogElement>("dialog")!;
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "revoke")
        void change({ userId: member.id, revoked: true }, `${member.name} can no longer use Paws.`);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[value="cancel"]')?.focus();
  }

  section.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-member-filter],[data-member-revoke],[data-member-restore]",
    );
    if (target === null) return;
    if (target.dataset.memberFilter) {
      filter = target.dataset.memberFilter as MemberFilter;
      render();
      return;
    }
    const member = members.find(
      (entry) => entry.id === (target.dataset.memberRevoke ?? target.dataset.memberRestore),
    );
    if (member === undefined) return;
    if (target.dataset.memberRevoke) confirmRevoke(member);
    else
      void change(
        { userId: member.id, revoked: false },
        `${member.name} can sign in again. Their runners stay revoked until they pair them again.`,
      );
  });
  section.addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement;
    const member = members.find((entry) => entry.id === select.dataset.memberRole);
    if (member === undefined || select.value === member.role) return;
    void change(
      { userId: member.id, role: select.value },
      `${member.name} is now ${select.value === "admin" ? "an admin" : "a member"}.`,
    );
  });
  refresh.addEventListener("click", () => void load());
  loadWhenShown("members", () => void load());
}
