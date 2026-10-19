import { describe, expect, test } from "bun:test";
import { ansiToHtml } from "./ansi";

describe("ansiToHtml", () => {
  test("plain text is escaped", () => {
    expect(ansiToHtml(`<img src=x onerror="alert(1)"> & 'q'`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;",
    );
  });

  test("colors and bold become classes around escaped text", () => {
    expect(ansiToHtml("\u001b[1;31m<b>fail</b>\u001b[0m done")).toBe(
      '<span class="ansi-bold ansi-fg-1">&lt;b&gt;fail&lt;/b&gt;</span> done',
    );
  });

  test("bright, background, reset and 256-color codes", () => {
    expect(ansiToHtml("\u001b[92mok\u001b[39m \u001b[44mbg\u001b[49m")).toBe(
      '<span class="ansi-fg-10">ok</span> <span class="ansi-bg-4">bg</span>',
    );
    expect(ansiToHtml("\u001b[38;5;9mred\u001b[38;5;200mpink\u001b[m")).toBe(
      '<span class="ansi-fg-9">red</span>pink',
    );
    expect(ansiToHtml("\u001b[38;2;1;2;3;1mtrue")).toBe('<span class="ansi-bold">true</span>');
    expect(ansiToHtml("\u001b[1mbold\u001b[22m plain")).toBe(
      '<span class="ansi-bold">bold</span> plain',
    );
  });

  test("non-SGR escapes and carriage-return redraws are dropped", () => {
    expect(ansiToHtml("\u001b[2Kline\u001b]0;title\u0007 \u001b(B")).toBe("line ");
    expect(ansiToHtml("10%\r50%\r100%\nnext\r\n")).toBe("100%\nnext\n");
  });

  test("an escape cut at the output cap does not leak", () => {
    expect(ansiToHtml("tail\u001b[3")).toBe("tail3");
    expect(ansiToHtml("tail\u001b")).toBe("tail");
  });
});
