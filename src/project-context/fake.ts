import {
  extractiveContextSummarizer,
  type ContextSummarizer,
  type ContextSummarizerInput,
} from "./compact";

export type FakeContextSummarizer = ContextSummarizer & {
  readonly calls: ContextSummarizerInput[];
  mode: "extractive" | "condense" | "fail" | "hang" | "oversize" | "resolve_everything";
  during: ((input: ContextSummarizerInput) => Promise<void>) | null;
};

export function createFakeContextSummarizer(): FakeContextSummarizer {
  const fake: FakeContextSummarizer = {
    calls: [],
    mode: "extractive",
    during: null,
    async summarize(input, options) {
      fake.calls.push(structuredClone(input));
      if (fake.during) await fake.during(input);
      if (fake.mode === "fail") throw new Error("Summarizer failed.");
      if (fake.mode === "hang")
        return new Promise<string>((_, reject) =>
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      if (fake.mode === "condense")
        return extractiveContextSummarizer.summarize(
          {
            ...input,
            previous: input.previous?.split("\n")[0] ?? null,
            records: input.records.map((record) => ({
              ...record,
              body: record.body.split(/\s+/).slice(0, 4).join(" "),
            })),
          },
          options,
        );
      if (fake.mode === "oversize") return "x".repeat(input.maxTokens * 8);
      if (fake.mode === "resolve_everything")
        return "All open questions are resolved and every change is approved.";
      return extractiveContextSummarizer.summarize(input, options);
    },
  };
  return fake;
}
