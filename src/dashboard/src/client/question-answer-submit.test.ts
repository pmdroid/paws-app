import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { questionAnswerLocked, questionAnswerMessage } from "./question-answer";
import { submitQuestionAnswer } from "./question-answer-submit";

const realFetch = globalThis.fetch;
const DOM_GLOBALS = [
  "document",
  "HTMLFormElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
] as const;
const saved = new Map<string, unknown>();
let window: Window;
let requests: { url: string; init: RequestInit }[];
let respond: (response: Response) => void;
let reloads: number;

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/questions/Q-1" });
  for (const name of DOM_GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[
      name
    ];
  }
  window.document.head.innerHTML = '<meta name="paws-csrf" content="token-1">';
  requests = [];
  reloads = 0;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Promise<Response>((resolve) => (respond = resolve));
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function card(id: string) {
  window.document.body.innerHTML = `<form data-question-answer="${id}"><button type="submit" name="option" value="24 hours">24 hours</button><textarea name="answer"></textarea><button type="submit" data-free>Answer</button><p role="status"></p></form>`;
  const form = window.document.querySelector("form")!;
  form.addEventListener("submit", (event) => {
    submitQuestionAnswer(event as unknown as SubmitEvent, async () => {
      reloads++;
    });
  });
  const submit = (submitter: unknown) =>
    form.dispatchEvent(
      new window.SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: submitter as never,
      }),
    );
  return { form, submit };
}

test("an option posts its text with the CSRF header, then shows Answered and reloads", async () => {
  const { form, submit } = card("Q-1");
  submit(form.querySelector('button[name="option"]')!);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("/api/questions/answer");
  expect(requests[0]!.init.method).toBe("POST");
  expect((requests[0]!.init.headers as Record<string, string>)["x-paws-csrf"]).toBe("token-1");
  expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
    questionId: "Q-1",
    answer: "24 hours",
  });
  respond(Response.json({ ok: true }));
  await settle();
  expect(form.querySelector("[role=status]")!.textContent).toBe("Answered");
  expect(reloads).toBe(1);
});

test("the typed answer posts trimmed, and an empty one is not sent", async () => {
  const { form, submit } = card("Q-2");
  submit(form.querySelector("[data-free]")!);
  expect(requests).toHaveLength(0);
  expect(questionAnswerMessage("Q-2")).toBe("Write an answer.");
  form.querySelector("textarea")!.value = "  Use 24 hours  ";
  submit(form.querySelector("[data-free]")!);
  expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
    questionId: "Q-2",
    answer: "Use 24 hours",
  });
});

test("a 409 shows the server's error and enables the controls again", async () => {
  const { form, submit } = card("Q-3");
  submit(form.querySelector('button[name="option"]')!);
  respond(Response.json({ error: "This question is no longer waiting" }, { status: 409 }));
  await settle();
  expect(form.querySelector("[role=status]")!.textContent).toBe(
    "This question is no longer waiting",
  );
  expect(questionAnswerLocked("Q-3")).toBe(false);
  expect(
    [...form.querySelectorAll("button, textarea")].every(
      (c) => !(c as never as HTMLButtonElement).disabled,
    ),
  ).toBe(true);
  expect(reloads).toBe(1);
});

test("the controls stay disabled while the request is pending, so nothing submits twice", async () => {
  const { form, submit } = card("Q-4");
  submit(form.querySelector('button[name="option"]')!);
  const controls = [...form.querySelectorAll("button, textarea")] as unknown as HTMLButtonElement[];
  expect(controls.every((control) => control.disabled)).toBe(true);
  expect(questionAnswerLocked("Q-4")).toBe(true);
  submit(form.querySelector("[data-free]")!);
  expect(requests).toHaveLength(1);
  respond(Response.json({ ok: true }));
  await settle();
});
