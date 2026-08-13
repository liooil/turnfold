import {describe, expect, test} from "bun:test";
import {IncrementalMarkdownCache} from "./incremental-markdown-cache.ts";

describe("incremental markdown cache", () => {
  test("never parses a stable prefix again", () => {
    const cache = new IncrementalMarkdownCache();
    const calls = [];
    const render = (source, type, index, stable) => {
      calls.push({source, type, index, stable});
      return {rendered: source.toUpperCase()};
    };

    cache.render("message", "first", render);
    const afterFirst = calls.length;
    const closed = cache.render("message", "first\n\n", render);
    const afterClosed = calls.length;
    const growingTail = cache.render("message", "first\n\nsecond", render);
    const longerTail = cache.render("message", "first\n\nsecond grows", render);

    expect(afterFirst).toBe(1);
    expect(afterClosed).toBe(2);
    expect(closed.blocks[0].stable).toBe(true);
    expect(growingTail.reused).toBe(1);
    expect(growingTail.parsed).toBe(1);
    expect(longerTail.reused).toBe(1);
    expect(longerTail.parsed).toBe(1);
    expect(calls.filter((call) => call.source === "first")).toHaveLength(2);
  });

  test("assigns stable indexes as blocks become frozen", () => {
    const cache = new IncrementalMarkdownCache();
    const render = () => ({});
    const first = cache.render("message", "one\n\ntwo", render);
    const second = cache.render("message", "one\n\ntwo\n\nthree", render);

    expect(first.blocks.map((block) => [block.index, block.stable])).toEqual([[0, true], [1, false]]);
    expect(second.blocks.map((block) => [block.index, block.stable])).toEqual([[0, true], [1, true], [2, false]]);
  });

  test("resets when the source is edited before the stable prefix", () => {
    const cache = new IncrementalMarkdownCache();
    const render = (source) => ({rendered: source});
    cache.render("message", "one\n\ntwo", render);
    const result = cache.render("message", "changed\n\ntwo", render);
    expect(result.reused).toBe(0);
    expect(result.blocks[0].source).toBe("changed");
  });

  test("moves cached blocks when a working message receives its immutable id", () => {
    const cache = new IncrementalMarkdownCache();
    const render = (source) => ({rendered: source});
    cache.render("working", "first\n\n", render);

    cache.move("working", "immutable");
    const result = cache.render("immutable", "first\n\nsecond", render);

    expect(cache.has("working")).toBe(false);
    expect(cache.has("immutable")).toBe(true);
    expect(result.reused).toBe(1);
    expect(result.blocks.map((block) => block.index)).toEqual([0, 1]);
  });

  test("freezes the final open block when the stream completes", () => {
    const cache = new IncrementalMarkdownCache();
    const render = (source) => ({rendered: source});
    cache.render("message", "last paragraph", render);

    const result = cache.render("message", "last paragraph", render, undefined, true);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].stable).toBe(true);
  });
});
