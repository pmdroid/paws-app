import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { settingsPageShown } from "./settings-loads";
import {
  ASK_AN_ADMIN,
  initializeWorkspaceMembers,
  type WorkspaceMemberRow,
} from "./workspace-members";

const realFetch = globalThis.fetch;
const DOM_GLOBALS = [
  "window",
  "navigator",
  "Node",
  "Element",
  "Event",
  "MouseEvent",
  "document",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLDialogElement",
  "HTMLFormElement",
  "HTMLSelectElement",
  "CSS",
] as const;
const saved = new Map<string, unknown>();
let window: Window;
let requests: { url: string; init: RequestInit | undefined }[];
let members: WorkspaceMemberRow[];

const NOW = Date.UTC(2026, 10, 4, 12);

function member(input: Partial<WorkspaceMemberRow> & { id: string }): WorkspaceMemberRow {
  return {
    name: input.id,
    email: `${input.id}@example.com`,
    role: "member",
    active: 1,
    revokedAt: null,
    revokedBy: null,
    revokedByName: null,
    lastSignInAt: NOW,
    runners: 0,
    openItems: 0,
    ...input,
  };
}

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/settings/members" });
  for (const name of DOM_GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  requests = [];
  members = [
    member({ id: "ada", name: "Ada Admin", role: "admin" }),
    member({ id: "bo", name: "Bo Builder", runners: 2, openItems: 3, lastSignInAt: null }),
    member({
      id: "cy",
      name: "Cy Gone",
      revokedAt: NOW,
      revokedBy: "ada",
      revokedByName: "Ada Admin",
    }),
    member({ id: "di", name: "Di Left", active: 0 }),
  ];
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return init?.method === "PUT"
      ? Response.json({ ok: true })
      : Response.json({ members: structuredClone(members) });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function open(role = "admin", userId = "ada") {
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as unknown as Parameters<typeof window.document.body.append>[0]);
  initializeWorkspaceMembers(root, { userId, role, csrfToken: "csrf-1" });
  settingsPageShown("members");
  await settle();
  return root;
}

function row(root: HTMLElement, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`tr[data-member="${id}"]`)!;
}

function click(element: Element) {
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

function puts() {
  return requests
    .filter((request) => request.init?.method === "PUT")
    .map((request) => ({
      url: request.url,
      csrf: new Headers(request.init!.headers).get("x-paws-csrf"),
      body: JSON.parse(String(request.init!.body)) as unknown,
    }));
}

test("the table renders name, email, role, status, last sign-in, runners and open items", async () => {
  const root = await open();
  expect([...root.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
    "Name",
    "Role",
    "Status",
    "Last sign-in",
    "Runners",
    "Open items",
    "Actions",
  ]);
  const cells = [...row(root, "bo").querySelectorAll("td")].map((cell) => cell.textContent);
  expect(cells[0]).toContain("Bo Builder");
  expect(cells[0]).toContain("bo@example.com");
  expect(row(root, "bo").querySelector("select")!.value).toBe("member");
  expect(cells[2]).toBe("Active");
  expect(cells[3]).toBe("Never");
  expect(cells[4]).toBe("2");
  expect(cells[5]).toBe("3");
  expect(row(root, "cy").textContent).toContain("Revoked");
  expect(row(root, "cy").textContent).toContain("by Ada Admin");
  expect(row(root, "cy").querySelector("time")!.getAttribute("datetime")).toBe(
    new Date(NOW).toISOString(),
  );
  expect(row(root, "di").textContent).toContain("Not in Linear");
});

test("the filter shows all, active or revoked members", async () => {
  const root = await open();
  const shown = () =>
    [...root.querySelectorAll("tbody tr")].map((tr) => tr.getAttribute("data-member"));
  expect(shown()).toEqual(["ada", "bo", "cy", "di"]);
  click(root.querySelector('[data-member-filter="active"]')!);
  expect(shown()).toEqual(["ada", "bo"]);
  click(root.querySelector('[data-member-filter="revoked"]')!);
  expect(shown()).toEqual(["cy"]);
  expect(root.querySelector('[data-member-filter="revoked"]')!.getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("a role change puts the new role with the CSRF token", async () => {
  members[1] = member({ id: "bo", name: "Bo Builder" });
  members.push(member({ id: "eve", name: "Eve Admin", role: "admin" }));
  const root = await open();
  const select = row(root, "bo").querySelector("select")!;
  select.value = "admin";
  select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  await settle();
  expect(puts()).toEqual([
    { url: "/api/workspaces/members", csrf: "csrf-1", body: { userId: "bo", role: "admin" } },
  ]);
  expect(root.querySelector("[data-members-feedback]")!.textContent).toBe(
    "Bo Builder is now an admin.",
  );
});

test("revoke confirms with the counts, then puts revoked with the CSRF token", async () => {
  const root = await open();
  click(row(root, "bo").querySelector("[data-member-revoke]")!);
  const dialog = root.querySelector<HTMLDialogElement>("dialog")!;
  expect(dialog.open).toBe(true);
  const items = [...dialog.querySelectorAll("li")].map((item) => item.textContent);
  expect(items).toEqual([
    "Signed out of Paws now.",
    "2 runners revoked.",
    "3 open items stopped.",
    "Can't sign in or delegate to Paws again until an admin restores access.",
  ]);
  expect(puts()).toEqual([]);
  click(dialog.querySelector("[data-member-confirm]")!);
  await settle();
  expect(puts()).toEqual([
    { url: "/api/workspaces/members", csrf: "csrf-1", body: { userId: "bo", revoked: true } },
  ]);
});

test("cancelling the revoke dialog changes nothing", async () => {
  const root = await open();
  click(row(root, "bo").querySelector("[data-member-revoke]")!);
  click(root.querySelector("dialog")!.querySelector('[value="cancel"]')!);
  expect(root.querySelector<HTMLDialogElement>("dialog")!.open).toBe(false);
  await settle();
  expect(puts()).toEqual([]);
});

test("a revoked row restores access", async () => {
  const root = await open();
  expect(row(root, "cy").querySelector("[data-member-revoke]")).toBeNull();
  expect(row(root, "cy").querySelector("select")!.disabled).toBe(true);
  click(row(root, "cy").querySelector("[data-member-restore]")!);
  await settle();
  expect(puts()).toEqual([
    { url: "/api/workspaces/members", csrf: "csrf-1", body: { userId: "cy", revoked: false } },
  ]);
});

test("your own row has no revoke button", async () => {
  members[0] = member({ id: "ada", name: "Ada Admin", role: "admin" });
  members.push(member({ id: "eve", name: "Eve Admin", role: "admin" }));
  const root = await open();
  expect(row(root, "ada").querySelector("[data-member-revoke]")).toBeNull();
  expect(row(root, "ada").textContent).toContain("(you)");
  expect(row(root, "eve").querySelector("[data-member-revoke]")).not.toBeNull();
});

test("the last admin's role and revoke are disabled with a reason", async () => {
  const root = await open("admin", "bo");
  const last = row(root, "ada");
  const select = last.querySelector("select")!;
  const revoke = last.querySelector<HTMLButtonElement>("[data-member-revoke]")!;
  expect(select.disabled).toBe(true);
  expect(revoke.disabled).toBe(true);
  const reason = last.querySelector("[data-member-reason]")!;
  expect(reason.textContent).toBe("The workspace must keep an active admin.");
  expect(select.getAttribute("aria-describedby")).toBe(reason.id);
  expect(revoke.getAttribute("aria-describedby")).toBe(reason.id);
});

test("a member sees the ask-an-admin text and loads nothing", async () => {
  const root = await open("member", "bo");
  expect(root.textContent).toBe(ASK_AN_ADMIN);
  expect(ASK_AN_ADMIN).toBe("Ask an admin to change members or roles.");
  expect(root.querySelector("table")).toBeNull();
  expect(requests).toEqual([]);
});
