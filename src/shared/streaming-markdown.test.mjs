import {describe, expect, test} from "bun:test";
import {splitStreamingMarkdown} from "./streaming-markdown.ts";

describe("streaming markdown blocks", () => {
  test("freezes a paragraph after its blank-line boundary", () => {
    const open = splitStreamingMarkdown("first paragraph");
    expect(open.blocks.map((block) => block.stable)).toEqual([false]);
    expect(open.stableOffset).toBe(0);

    const closed = splitStreamingMarkdown("first paragraph\n\n");
    expect(closed.blocks.map((block) => block.stable)).toEqual([true]);
    expect(closed.stableOffset).toBe("first paragraph\n\n".length);
  });

  test("keeps only the trailing paragraph mutable", () => {
    const source = "first paragraph\n\nsecond paragraph";
    const result = splitStreamingMarkdown(source);
    expect(result.blocks.map(({source, stable}) => [source, stable])).toEqual([
      ["first paragraph", true],
      ["second paragraph", false]
    ]);
    expect(source.slice(0, result.stableOffset)).toBe("first paragraph\n\n");
  });

  test("keeps a list mutable because another item can merge after a blank line", () => {
    const result = splitStreamingMarkdown("- first\n\n");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].stable).toBe(false);
    expect(result.stableOffset).toBe(0);
  });

  test("freezes fenced code only after its closing fence", () => {
    expect(splitStreamingMarkdown("```ts\nconst x = 1").blocks[0].stable).toBe(false);
    expect(splitStreamingMarkdown("```ts\nconst x = 1\n```\n").blocks[0].stable).toBe(true);
  });

  test("freezes a standalone display formula when its delimiter closes", () => {
    expect(splitStreamingMarkdown("$$\\int_0^1 x dx").blocks[0].stable).toBe(false);
    expect(splitStreamingMarkdown("$$\\int_0^1 x dx$$").blocks[0].stable).toBe(true);
    expect(splitStreamingMarkdown("\\[\\frac{a}{b}\\]").blocks[0].stable).toBe(true);
  });

  test("marks every block stable after the stream completes", () => {
    const result = splitStreamingMarkdown("paragraph without trailing newline", true);
    expect(result.blocks[0].stable).toBe(true);
    expect(result.stableOffset).toBe("paragraph without trailing newline".length);
  });
});
