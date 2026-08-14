import {splitStreamingMarkdown} from "./streaming-markdown";

export type IncrementalMarkdownBlock<T> = T & {
  source: string;
  type: string;
  index: number;
  stable: boolean;
};

export type IncrementalMarkdownResult<T> = {
  blocks: Array<IncrementalMarkdownBlock<T>>;
  parsed: number;
  reused: number;
};

type IncrementalMarkdownState<T> = {
  stableSource: string;
  stableBlocks: Array<IncrementalMarkdownBlock<T>>;
  nextIndex: number;
};

export class IncrementalMarkdownCache<T> {
  private readonly states = new Map<string, IncrementalMarkdownState<T>>();

  render(
    messageId: string,
    value: string,
    renderBlock: (source: string, type: string, index: number, stable: boolean) => T,
    onSplit?: (durationMs: number) => void,
    complete = false
  ): IncrementalMarkdownResult<T> {
    let state = this.states.get(messageId);
    if (!state || !value.startsWith(state.stableSource)) {
      state = {stableSource: "", stableBlocks: [], nextIndex: 0};
      this.states.set(messageId, state);
    }
    if (value === state.stableSource) return {blocks: state.stableBlocks, parsed: 0, reused: state.stableBlocks.length};

    const tail = value.slice(state.stableSource.length);
    const startedAt = performance.now();
    const split = splitStreamingMarkdown(tail, complete);
    onSplit?.(performance.now() - startedAt);
    const renderedTail = split.blocks.map((block, offset) => ({
      ...renderBlock(block.source, block.type, state!.nextIndex + offset, block.stable),
      source: block.source,
      type: block.type,
      index: state!.nextIndex + offset,
      stable: block.stable
    }));
    const newlyStable = renderedTail.filter((_block, index) => split.blocks[index].end <= split.stableOffset);
    const previouslyStableCount = state.stableBlocks.length;
    if (split.stableOffset > 0) {
      state.stableSource += tail.slice(0, split.stableOffset);
      state.stableBlocks.push(...newlyStable);
      state.nextIndex += newlyStable.length;
    }
    return {
      blocks: [...state.stableBlocks.slice(0, state.stableBlocks.length - newlyStable.length), ...renderedTail],
      parsed: renderedTail.length,
      reused: previouslyStableCount
    };
  }

  delete(messageId: string) {
    this.states.delete(messageId);
  }

  move(fromMessageId: string, toMessageId: string) {
    if (fromMessageId === toMessageId) return;
    const state = this.states.get(fromMessageId);
    if (!state) return;
    this.states.set(toMessageId, state);
    this.states.delete(fromMessageId);
  }

  has(messageId: string) {
    return this.states.has(messageId);
  }
}
