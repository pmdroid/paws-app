import type { RunAgentOptions, RunAgentResult } from "../acp";
import type { AgentTurn } from "./types";

/** Run one turn and keep the text of the agent's reply. Throws when the turn did not finish. */
export async function replyOf(
  turn: AgentTurn,
  options: RunAgentOptions,
): Promise<{ result: RunAgentResult; text: string }> {
  let text = "";
  const result = await turn({
    ...options,
    onEvent(event) {
      if (event.type !== "session_update") return;
      if (event.update.sessionUpdate !== "agent_message_chunk") return;
      if (event.update.content.type === "text") text += event.update.content.text ?? "";
    },
  });
  if (result.authRequired)
    throw new Error(result.errorMessage ?? "Sign the agent in on this machine first.");
  if (result.cancelled || result.timedOut || result.stopReason !== "end_turn")
    throw new Error(result.errorMessage ?? `The agent turn did not finish: ${result.stopReason}`);
  return { result, text };
}

/** The JSON value in a reply: a fenced block when there is one, else the outermost object. */
export function jsonIn(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!body.trim()) throw new Error("The agent's reply had no JSON object.");
  return JSON.parse(body);
}
