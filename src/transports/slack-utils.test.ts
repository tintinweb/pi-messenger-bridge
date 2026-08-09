import { describe, expect, it } from "vitest";
import { formatForSlack } from "./slack-utils.js";

describe("formatForSlack", () => {
  it("returns plain text unchanged", () => {
    expect(formatForSlack("hello world")).toBe("hello world");
  });

  it("converts **bold** to *bold*", () => {
    expect(formatForSlack("this is **bold** text")).toBe("this is *bold* text");
  });

  it("converts *italic* (asterisk) to _italic_", () => {
    expect(formatForSlack("this is *italic* text")).toBe("this is _italic_ text");
  });

  it("leaves _italic_ (underscore) as-is", () => {
    expect(formatForSlack("this is _italic_ text")).toBe("this is _italic_ text");
  });

  it("does not confuse **bold** with *italic*", () => {
    expect(formatForSlack("**bold** and *italic*")).toBe("*bold* and _italic_");
  });

  it("converts ~~strike~~ to ~strike~", () => {
    expect(formatForSlack("this is ~~struck~~ text")).toBe("this is ~struck~ text");
  });

  it("converts [text](url) to <url|text>", () => {
    expect(formatForSlack("see [docs](https://example.com)")).toBe("see <https://example.com|docs>");
  });

  it("converts headers to bold lines", () => {
    expect(formatForSlack("# Title")).toBe("*Title*");
    expect(formatForSlack("### Subsection")).toBe("*Subsection*");
  });

  it("collapses a header containing bold into a single bold span, not nested double asterisks", () => {
    expect(formatForSlack("## **Important**")).toBe("*Important*");
  });

  it("resolves a link inside a header", () => {
    expect(formatForSlack("### See [docs](https://example.com)")).toBe("*See <https://example.com|docs>*");
  });

  it("converts ***bold italic*** to *_bold italic_*", () => {
    expect(formatForSlack("***Bold italic***")).toBe("*_Bold italic_*");
  });

  it("converts nested italic inside bold instead of leaving the outer ** untouched", () => {
    expect(formatForSlack("**bold *and italic* together**")).toBe("*bold _and italic_ together*");
  });

  it("converts a link nested inside bold", () => {
    expect(formatForSlack("**bold [link](https://x.com) inside**")).toBe("*bold <https://x.com|link> inside*");
  });

  it("converts strikethrough nested inside bold", () => {
    expect(formatForSlack("**bold ~~struck~~ inside**")).toBe("*bold ~struck~ inside*");
  });

  it("handles two separate bold spans on the same line", () => {
    expect(formatForSlack("**A** and **B**")).toBe("*A* and *B*");
  });

  it("converts bullet list markers to •", () => {
    expect(formatForSlack("- item one\n- item two")).toBe("• item one\n• item two");
    expect(formatForSlack("* item one\n* item two")).toBe("• item one\n• item two");
  });

  it("preserves indentation on bullet lines", () => {
    expect(formatForSlack("- top\n  - nested")).toBe("• top\n  • nested");
  });

  it("leaves numbered lists unchanged", () => {
    expect(formatForSlack("1. first\n2. second")).toBe("1. first\n2. second");
  });

  it("passes fenced code blocks through unmodified even with markdown-like content inside", () => {
    const input = "```\n**not bold** _not italic_ # not a header\n- not a bullet\n```";
    expect(formatForSlack(input)).toBe(input);
  });

  it("passes inline code through unmodified", () => {
    expect(formatForSlack("run `**not bold**` now")).toBe("run `**not bold**` now");
  });

  describe("tables", () => {
    it("converts a simple GFM table to a fenced, padded plain-text table", () => {
      const input = ["| Name | Age |", "| --- | --- |", "| Alice | 30 |", "| Bob | 7 |"].join("\n");
      const result = formatForSlack(input);
      expect(result.startsWith("```\n")).toBe(true);
      expect(result.endsWith("\n```")).toBe(true);
      expect(result).toContain("Name  | Age");
      expect(result).toContain("Alice | 30 ");
      expect(result).toContain("Bob   | 7  ");
    });

    it("handles ragged/varying cell widths", () => {
      const input = ["| A | Longer Header |", "|---|---|", "| x | y |"].join("\n");
      const result = formatForSlack(input);
      const lines = result.split("\n");
      // header separator (dash) line width should match header column width
      const headerLine = lines[1];
      const sepLine = lines[2];
      expect(headerLine.split("|")[1].length).toBe(sepLine.split("|")[1].length);
    });

    it("ignores alignment colons in the separator row", () => {
      const input = ["| Left | Right |", "|:---|---:|", "| a | b |"].join("\n");
      const result = formatForSlack(input);
      expect(result).toContain("Left | Right");
      expect(result).toContain("a    | b");
    });

    it("only converts the table lines, leaving surrounding text untouched", () => {
      const input = ["Before text.", "| A | B |", "| --- | --- |", "| 1 | 2 |", "After text."].join("\n");
      const result = formatForSlack(input);
      expect(result.startsWith("Before text.\n```")).toBe(true);
      expect(result.endsWith("```\nAfter text.")).toBe(true);
    });

    it("does not mistake a lone pipe-containing line for a table", () => {
      const input = "Value is a | b, just prose.\nNo separator follows.";
      expect(formatForSlack(input)).toBe(input);
    });
  });

  it("handles realistic mixed LLM output", () => {
    const input = [
      "## Summary",
      "",
      "Here is **bold**, *italic*, and a [link](https://example.com).",
      "",
      "| Metric | Value |",
      "| --- | --- |",
      "| Latency | 12ms |",
      "",
      "- first point",
      "- second point",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");

    const result = formatForSlack(input);

    expect(result).toContain("*Summary*");
    expect(result).toContain("*bold*");
    expect(result).toContain("_italic_");
    expect(result).toContain("<https://example.com|link>");
    expect(result).toContain("Metric  | Value");
    expect(result).toContain("• first point");
    expect(result).toContain("• second point");
    expect(result).toContain("```js\nconst x = 1;\n```");
  });
});
