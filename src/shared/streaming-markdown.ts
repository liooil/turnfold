import {marked} from "marked";

export type StreamingMarkdownBlock = {
  source: string;
  type: string;
  start: number;
  end: number;
  stable: boolean;
};

export type StreamingMarkdownSplit = {
  blocks: StreamingMarkdownBlock[];
  stableOffset: number;
};

type BlockToken = {type: string; raw: string};

function hasClosedFence(raw: string) {
  const opening = raw.match(/^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/);
  if (!opening) return false;
  const marker = opening[2];
  const character = marker[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const closing = new RegExp(`(?:^|\\n) {0,3}${character}{${marker.length},}[ \\t]*(?:\\n|$)`);
  return closing.test(raw.slice(opening[0].length));
}

function isClosedDisplayMath(raw: string) {
  const value = raw.trim();
  return /^\$\$(?!\$)[\s\S]*?(?<!\\)\$\$$/.test(value)
    || /^\\\[[\s\S]*?\\\]$/.test(value);
}

function isSelfClosing(token: BlockToken, following: BlockToken | undefined) {
  if (token.type === "heading") return token.raw.endsWith("\n");
  if (token.type === "hr") return true;
  if (token.type === "code") return hasClosedFence(token.raw);
  if (token.type === "paragraph") {
    if (isClosedDisplayMath(token.raw)) return true;
    return following?.type === "space" && /\n[\t ]*\n/.test(following.raw);
  }
  if (token.type === "def") return token.raw.endsWith("\n");
  return false;
}

export function splitStreamingMarkdown(source: string, complete = false): StreamingMarkdownSplit {
  if (!source) return {blocks: [], stableOffset: 0};
  const tokens = marked.lexer(source) as unknown as BlockToken[];
  const records: Array<BlockToken & {start: number; end: number}> = [];
  let offset = 0;
  for (const token of tokens) {
    const start = offset;
    offset += token.raw.length;
    records.push({...token, start, end: offset});
  }

  const semanticIndexes = records.flatMap((token, index) => token.type === "space" ? [] : [index]);
  const lastSemanticIndex = semanticIndexes.at(-1) ?? -1;
  let firstUnstableStart = source.length;
  const blocks: StreamingMarkdownBlock[] = [];

  for (const index of semanticIndexes) {
    const token = records[index];
    const stable = complete || index < lastSemanticIndex || isSelfClosing(token, records[index + 1]);
    if (!stable && firstUnstableStart === source.length) firstUnstableStart = token.start;
    if (token.type === "def") continue;
    blocks.push({
      source: token.raw,
      type: token.type,
      start: token.start,
      end: token.end,
      stable
    });
  }

  if (complete || firstUnstableStart === source.length) return {blocks, stableOffset: source.length};
  return {blocks, stableOffset: firstUnstableStart};
}
