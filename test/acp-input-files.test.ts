import { expect, test } from "bun:test";
import { buildAgentPrompt, snapshotAgentInputs } from "../src/acp";

const bytes = new Uint8Array([1, 2, 3]);

test("input files snapshot caller bytes and keep binary resources behind capability negotiation", () => {
  const original = new Uint8Array(bytes);
  const inputs = snapshotAgentInputs("/workspace", [
    { path: "inputs/report.pdf", mimeType: "application/pdf", bytes: original },
  ]);
  original.fill(0);
  expect(inputs[0]?.bytes).toEqual(bytes);
  expect(buildAgentPrompt("Read", "/workspace", inputs, { image: true })).toHaveLength(2);
  expect(
    buildAgentPrompt("Read", "/workspace", inputs, { embeddedContext: true })[2],
  ).toMatchObject({
    type: "resource",
    resource: {
      uri: "file:///workspace/inputs/report.pdf",
      mimeType: "application/pdf",
      blob: "AQID",
    },
  });
});

test("input files reject paths outside the workspace and unbounded prompt bodies", () => {
  for (const path of ["../secret", "/outside/file", "."]) {
    expect(() =>
      snapshotAgentInputs("/workspace", [{ path, mimeType: "image/png", bytes }]),
    ).toThrow("inside the workspace");
  }
  expect(() =>
    snapshotAgentInputs(
      "/workspace",
      Array.from({ length: 21 }, () => ({ path: "input", mimeType: "text/plain", bytes })),
    ),
  ).toThrow("file limit");
  expect(() =>
    snapshotAgentInputs("/workspace", [
      { path: "input", mimeType: "image/png", bytes: new Uint8Array(20 * 1024 * 1024 + 1) },
    ]),
  ).toThrow("content limits");
});
