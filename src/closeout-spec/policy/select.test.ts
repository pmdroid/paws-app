import { expect, test } from "bun:test";
import { loadMemoryPolicy, PUBLIC_POLICY_PATH } from "./resolve";

const SKILL = ".agents/skills/review/SKILL.md";

function policy(item: string): string {
  return `specVersion: "0.1"
items:
  - id: review
    kind: review
    gate: beforePR
    skill: ${SKILL}
    independence: { differentSession: true, differentModel: true }
    failOn: P1
${item}`;
}

function command(exec: string, extra = ""): string {
  return `  - id: test
    kind: command
    gate: beforePR
    exec: ${exec}
    timeoutSeconds: 600
${extra}`;
}

const SELECT = `    select:
      runner: bun
      always: [test/boundaries.test.ts]
      full_on: ["package.json", "bun.lock"]
      max_selected: 120
`;

function load(text: string) {
  const encode = (value: string) => new TextEncoder().encode(value);
  return loadMemoryPolicy(
    new Map([
      [PUBLIC_POLICY_PATH, encode(text)],
      [SKILL, encode("# Review\n")],
    ]),
  );
}

function failure(text: string): string {
  const loaded = load(text);
  if (loaded.ok) throw new Error("expected a policy error");
  return loaded.message.slice(`${PUBLIC_POLICY_PATH}: `.length);
}

test("a command with select parses and the resolved policy and digest carry it", () => {
  const exec = '["bun", "test", "--parallel=4", "--timeout=20000"]';
  const loaded = load(policy(command(exec, SELECT)));
  if (!loaded.ok || loaded.absent) throw new Error("policy did not load");
  expect(loaded.policy.items[1]).toMatchObject({
    id: "test",
    exec: ["bun", "test", "--parallel=4", "--timeout=20000"],
    select: {
      runner: "bun",
      always: ["test/boundaries.test.ts"],
      full_on: ["package.json", "bun.lock"],
      max_selected: 120,
    },
  });
  const plain = load(policy(command(exec)));
  if (!plain.ok || plain.absent) throw new Error("policy did not load");
  expect(plain.policy.items[1]).not.toHaveProperty("select");
  expect(plain.policy.digest).not.toBe(loaded.policy.digest);
});

test("invalid select is a policy error with a clear message", () => {
  const bun = '["bun", "test"]';
  expect(failure(policy(command(bun, `    select: { runner: pytest }\n`)))).toBe(
    "/items/1/select/runner must be equal to one of the allowed values",
  );
  expect(failure(policy(command(bun, `    select: { always: [a] }\n`)))).toBe(
    "/items/1/select must have required property 'runner'",
  );
  expect(failure(policy(command(bun, `    select: { runner: bun, max_selected: 0 }\n`)))).toBe(
    "/items/1/select/max_selected must be >= 1",
  );
  expect(failure(policy(command(bun, `    since: ["bun", "test", "{since}"]\n${SELECT}`)))).toBe(
    "item test: select cannot be used with since",
  );
  const shape =
    'item test: select runner bun needs exec to start with "bun", "test" and pass only flags, as --flag=value';
  expect(failure(policy(command('["bun", "run", "test"]', SELECT)))).toBe(shape);
  expect(failure(policy(command('["bun", "test", "test/a.test.ts"]', SELECT)))).toBe(shape);
  expect(failure(policy(command('["bun", "test", "--timeout", "100"]', SELECT)))).toBe(shape);
  const misplaced = policy(command(bun)).replace(
    "    failOn: P1\n",
    `    failOn: P1\n    select: { runner: bun }\n`,
  );
  expect(failure(misplaced)).toBe("/items/0/select is only allowed on kind: command items");
});
