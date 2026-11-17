import { expect, test } from "bun:test";
import { createStreamScrubber, scrubText } from "./scrub";

const prefixes = ["paws_at_", "paws_rt_"];
const body = "Zq7".repeat(14) + "w";

test("scrubText redacts Paws access and refresh tokens", () => {
  for (const prefix of prefixes) {
    expect(scrubText(`token=${prefix}${body} done`, [])).toBe("token=[redacted] done");
  }
});

test("the stream scrubber redacts a Paws token split across two pushes", () => {
  for (const prefix of prefixes) {
    const text = `before ${prefix}${body} after`;
    const start = "before ".length;
    const splits = [
      ...Array.from({ length: prefix.length - 1 }, (_, index) => start + index + 1),
      start + prefix.length + 10,
      start + prefix.length + 30,
    ];
    for (const split of splits) {
      const scrubber = createStreamScrubber([]);
      const out =
        scrubber.push(text.slice(0, split)) + scrubber.push(text.slice(split)) + scrubber.flush();
      expect(out).toBe("before [redacted] after");
    }
  }
});

test("text naming paws_evidence_dir or PAWS_HOME is unchanged", () => {
  const text = "paws_evidence_dir=/tmp/proof PAWS_HOME=/home/me/.paws";
  expect(scrubText(text, [])).toBe(text);
  const scrubber = createStreamScrubber([]);
  const out = scrubber.push(text.slice(0, 7)) + scrubber.push(text.slice(7)) + scrubber.flush();
  expect(out).toBe(text);
});
