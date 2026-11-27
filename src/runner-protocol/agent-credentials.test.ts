import { expect, test } from "bun:test";
import { accessCredentialFiles } from "./agent-credentials";

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const decoded = (data: string) => JSON.parse(Buffer.from(data, "base64").toString());

test("a central Grok sign-in goes to the runner access-only", () => {
  const stored = {
    key: "grok-access",
    refresh_token: "grok-refresh",
    user_id: "u1",
    email: "a@example.com",
    create_time: "2026-11-18T01:10:00Z",
  };
  const [file] = accessCredentialFiles(
    JSON.stringify([{ path: ".grok/auth.json", data: encoded(stored) }]),
  );
  expect(file?.path).toBe(".grok/auth.json");
  expect(decoded(file!.data)).toEqual({ ...stored, refresh_token: null });
});

test("a central Claude sign-in file is still refused", () => {
  expect(() =>
    accessCredentialFiles(
      JSON.stringify([{ path: ".claude/.credentials.json", data: encoded({}) }]),
    ),
  ).toThrow("Unsupported central credential");
});
