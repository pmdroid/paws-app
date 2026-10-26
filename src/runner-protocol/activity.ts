import { journalCaught } from "../journal";
import { z } from "zod";

const textContent = z.object({ type: z.literal("text"), text: publicString(262_144) });
const tool = {
  toolCallId: z.string().min(1).max(1024),
  title: publicString(4096).optional(),
  kind: z
    .enum([
      "read",
      "edit",
      "delete",
      "move",
      "search",
      "execute",
      "think",
      "fetch",
      "switch_mode",
      "other",
    ])
    .optional(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  content: z
    .array(z.object({ type: z.literal("content"), content: textContent }))
    .max(256)
    .optional(),
  _meta: z
    .object({
      terminal_output: z.object({ data: z.string().max(262_144) }).optional(),
      terminal_output_delta: z.object({ data: z.string().max(262_144) }).optional(),
    })
    .optional(),
};

const activity = z.discriminatedUnion("sessionUpdate", [
  z.object({
    sessionUpdate: z.literal("agent_message_chunk"),
    content: z.object({ type: z.literal("text"), text: z.string().max(262_144) }),
  }),
  z.object({ ...tool, sessionUpdate: z.literal("tool_call"), title: publicString(4096) }),
  z.object({ ...tool, sessionUpdate: z.literal("tool_call_update") }),
  z.object({
    sessionUpdate: z.literal("plan"),
    entries: z
      .array(
        z.object({
          content: publicString(16_384),
          priority: z.enum(["high", "medium", "low"]),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      )
      .max(256),
  }),
]);

export const RunnerPermissionSchema = z.strictObject({
  toolCallId: z.string().min(1).max(1024),
  decision: z.enum(["allow", "deny", "cancelled"]),
  reason: publicString(1024),
  optionId: z.string().max(1024).optional(),
  title: publicString(4096).nullable().optional(),
  kind: z.string().max(64).nullable().optional(),
  name: z.string().max(256).nullable().optional(),
});

function publicString(limit: number) {
  return z
    .string()
    .transform(publicText)
    .pipe(z.string().max(limit * 3));
}

export const RunnerActivitySchema = activity.transform((update) => {
  if (update.sessionUpdate === "agent_message_chunk") return update;
  if (update.sessionUpdate === "plan")
    return {
      ...update,
      entries: update.entries.map((entry) => ({ ...entry, content: publicText(entry.content) })),
    };
  return {
    ...update,
    ...(update.title === undefined ? {} : { title: publicText(update.title) }),
    ...(update.rawInput === undefined ? {} : { rawInput: publicValue(update.rawInput) }),
    ...(update.rawOutput === undefined ? {} : { rawOutput: publicValue(update.rawOutput) }),
    ...(update.content === undefined
      ? {}
      : {
          content: update.content.map((part) => ({
            ...part,
            content: { ...part.content, text: publicText(part.content.text) },
          })),
        }),
  };
});

function publicValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return publicText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 32) return "[truncated]";
  if (Array.isArray(value)) return value.map((entry) => publicValue(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      /reasoning|thought|analysis/i.test(key)
        ? []
        : [
            [
              key,
              /api.?key|password|secret|token|authorization|cookie|credential|private.?key/i.test(
                key,
              )
                ? "[redacted]"
                : publicValue(entry, depth + 1),
            ],
          ],
    ),
  );
}

function publicText(text: string): string {
  return text
    .replace(
      /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}/g,
      "[redacted]",
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [redacted]")
    .replace(
      /\b([\w-]*(?:api[_-]?key|password|secret|token|authorization|cookie)[\w-]*["']?\s*[:=]\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      (_match, prefix: string, value: string) =>
        `${prefix}${value.startsWith('"') ? '"[redacted]"' : value.startsWith("'") ? "'[redacted]'" : "[redacted]"}`,
    )
    .replace(/https?:\/\/[^\s<>"']+/g, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
      } catch (caughtError1) {
        journalCaught(caughtError1, "activity.publicText", null);
        return "[redacted URL]";
      }
    });
}
