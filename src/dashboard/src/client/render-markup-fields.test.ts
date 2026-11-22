import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderMarkup } from "./theme";
import { settleReactWork } from "./settle-react";

const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
] as const;
const saved = new Map<string, unknown>();
let window: Window;
let root: HTMLElement;

beforeEach(() => {
  window = new Window({ url: "http://127.0.0.1:8787/dashboard" });
  for (const name of DOM_GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
  root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as unknown as Parameters<typeof window.document.body.append>[0]);
});

afterEach(async () => {
  await settleReactWork();
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

const field = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;

test("a typed, focused field keeps its value, focus and caret across a re-render", () => {
  renderMarkup(root, '<p>1 min ago</p><textarea id="answer"></textarea>');
  const answer = field<HTMLTextAreaElement>("#answer");
  answer.focus();
  answer.value = "Use the staging database";
  answer.setSelectionRange(4, 7, "backward");
  renderMarkup(root, '<p>2 min ago</p><textarea id="answer"></textarea>');
  const next = field<HTMLTextAreaElement>("#answer");
  expect(next).not.toBe(answer);
  expect(next.value).toBe("Use the staging database");
  expect(window.document.activeElement as unknown).toBe(next);
  expect([next.selectionStart, next.selectionEnd, next.selectionDirection]).toEqual([
    4,
    7,
    "backward",
  ]);
});

test("a named field inside an identified form keeps what was typed", () => {
  renderMarkup(root, '<form data-settings="merge"><input name="labels" value="a"></form>');
  field<HTMLInputElement>('[name="labels"]').value = "a, b";
  renderMarkup(
    root,
    '<form data-settings="merge"><b>Saved</b><input name="labels" value="a"></form>',
  );
  expect(field<HTMLInputElement>('[name="labels"]').value).toBe("a, b");
});

test("a field whose markup default changed takes the new default", () => {
  renderMarkup(root, '<input id="model" value="sonnet">');
  const model = field<HTMLInputElement>("#model");
  model.focus();
  model.value = "opus";
  renderMarkup(root, '<input id="model" value="haiku">');
  expect(field<HTMLInputElement>("#model").value).toBe("haiku");
  expect(window.document.activeElement as unknown).toBe(field("#model"));
});

test("an untouched, unfocused field takes the new markup", () => {
  renderMarkup(root, '<input id="name" value="old">');
  renderMarkup(root, '<input id="name" value="new">');
  expect(field<HTMLInputElement>("#name").value).toBe("new");
});

test("a field without identity is left alone", () => {
  renderMarkup(root, '<input name="loose" value="x"><input value="y">');
  field<HTMLInputElement>('[name="loose"]').value = "typed";
  field<HTMLInputElement>('[value="y"]').value = "typed";
  renderMarkup(root, '<input name="loose" value="x"><input value="y">');
  expect(field<HTMLInputElement>('[name="loose"]').value).toBe("x");
  expect(field<HTMLInputElement>('[value="y"]').value).toBe("y");
});

test("a focused field whose default follows the draft keeps its caret", () => {
  renderMarkup(root, '<form data-question-answer="q1"><textarea name="answer"></textarea></form>');
  const answer = field<HTMLTextAreaElement>('[name="answer"]');
  answer.focus();
  answer.value = "hello world";
  answer.setSelectionRange(5, 5);
  renderMarkup(
    root,
    '<form data-question-answer="q1"><textarea name="answer">hello world</textarea></form>',
  );
  const next = field<HTMLTextAreaElement>('[name="answer"]');
  expect(window.document.activeElement as unknown).toBe(next);
  expect([next.value, next.selectionStart, next.selectionEnd]).toEqual(["hello world", 5, 5]);
});
