import DOMPurify from "dompurify";
import {marked} from "marked";
import {IncrementalMarkdownCache} from "../shared/incremental-markdown-cache";
import {protectMath, restoreMath} from "../shared/math-markdown";
import {mathJaxAssetPath} from "./environment";

type MathJaxRuntime = {
  startup?: {promise?: Promise<void>};
  typesetPromise?: (elements?: Element[]) => Promise<void>;
  typesetClear?: (elements?: Element[]) => void;
};

type RenderedMarkdownBlock = {
  id: string;
  index: number;
  type: string;
  source: string;
  html: string;
  renderKey: string;
  hasMath: boolean;
  stable: boolean;
};

export const streamingMarkdownCaches = new IncrementalMarkdownCache<Omit<RenderedMarkdownBlock, "source" | "type" | "index" | "stable">>();
export const finishingMarkdownMessages = new Set<string>();
export const markdownRenderMetrics = {lexMs: 0, parseMs: 0, blocksParsed: 0, blocksReused: 0, domBlocksUpdated: 0, mathTypesets: 0};
(window as typeof window & {__turnfoldRenderMetrics?: typeof markdownRenderMetrics}).__turnfoldRenderMetrics = markdownRenderMetrics;

// Completed messages that never went through the streaming cache (imported or
// rendered after a page reload) were re-parsed and re-sanitized on every render.
// Cache their single-document render keyed by message id + source identity.
const completedMarkdownCache = new Map<string, {source: string; block: RenderedMarkdownBlock}>();

export function createMarkdownRenderer(options: {
  root: HTMLElement;
  escapeHtml: (value: unknown) => string;
  isViewportAtBottom: (viewport: HTMLElement | null) => boolean;
  scrollBottom: () => void;
}) {
  function markdown(value: string) {
    const {source, fragments} = protectMath(value);
    const html = marked.parse(source, {async: false, gfm: true, breaks: false}) as string;
    return {html: DOMPurify.sanitize(restoreMath(html, fragments)), hasMath: fragments.length > 0};
  }

  function markdownRenderKey(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${value.length}-${(hash >>> 0).toString(36)}`;
  }

  // renderMarkdownContainer hashes the full message text on every render; the
  // result only changes when the text changes, so memoize per message id.
  const containerRenderKeyCache = new Map<string, {value: string; key: string}>();
  function containerRenderKey(value: string, messageId: string) {
    const cached = containerRenderKeyCache.get(messageId);
    if (cached && cached.value === value) return cached.key;
    const key = markdownRenderKey(value);
    containerRenderKeyCache.set(messageId, {value, key});
    return key;
  }

  function renderMarkdownBlock(source: string, messageId: string, index: number, type: string, stable: boolean): RenderedMarkdownBlock {
    const startedAt = performance.now();
    const rendered = markdown(source);
    markdownRenderMetrics.parseMs += performance.now() - startedAt;
    markdownRenderMetrics.blocksParsed += 1;
    return {id: `${messageId}:markdown:${index}`, index, type, source, html: rendered.html, renderKey: markdownRenderKey(source), hasMath: rendered.hasMath, stable};
  }

  function markdownBlocks(value: string, messageId: string, complete: boolean) {
    if (complete && !streamingMarkdownCaches.has(messageId)) {
      const cached = completedMarkdownCache.get(messageId);
      if (cached && cached.source === value) return [cached.block];
      const block = renderMarkdownBlock(value, messageId, 0, "document", true);
      completedMarkdownCache.set(messageId, {source: value, block});
      return [block];
    }
    const result = streamingMarkdownCaches.render(
      messageId,
      value,
      (source, type, index, stable) => renderMarkdownBlock(source, messageId, index, type, stable),
      (durationMs) => { markdownRenderMetrics.lexMs += durationMs; },
      complete
    );
    markdownRenderMetrics.blocksReused += result.reused;
    return result.blocks;
  }

  function markdownBlockMarkup(block: RenderedMarkdownBlock) {
    return `<div class="markdown-block" data-block-id="${options.escapeHtml(block.id)}" data-block-index="${block.index}" data-block-type="${options.escapeHtml(block.type)}" data-render-key="${block.renderKey}" data-block-stable="${block.stable ? "1" : "0"}" data-has-math="${block.hasMath ? "1" : "0"}">${block.html}</div>`;
  }

  function renderMarkdownContainer(value: string, messageId: string, complete: boolean) {
    const blocks = markdownBlocks(value, messageId, complete);
    return `<div class="aui-md" data-render-key="${containerRenderKey(value, messageId)}">${blocks.map(markdownBlockMarkup).join("")}</div>`;
  }

  function mathJaxRuntime() {
    return (window as typeof window & {MathJax?: MathJaxRuntime}).MathJax;
  }

  let mathJaxLoad: Promise<MathJaxRuntime> | null = null;
  let mathTypesetChain = Promise.resolve();
  let mathTypesetFrame = 0;
  const pendingMathElements = new Map<HTMLElement, string>();

  function ensureMathJax() {
    const active = mathJaxRuntime();
    if (active?.typesetPromise) return Promise.resolve(active);
    if (mathJaxLoad) return mathJaxLoad;
    (window as typeof window & {MathJax?: unknown}).MathJax = {
      loader: {paths: {fonts: `${mathJaxAssetPath}/fonts`}},
      output: {font: "mathjax-newcm"},
      tex: {inlineMath: {"[+]": [["$", "$"]]}, processEscapes: true},
      options: {enableSpeech: false, enableBraille: false, enableExplorer: false, menuOptions: {settings: {speech: false, braille: false}}},
      svg: {fontCache: "local"},
      startup: {typeset: false}
    };
    mathJaxLoad = new Promise<MathJaxRuntime>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${mathJaxAssetPath}/tex-svg-nofont.js`;
      script.async = true;
      script.dataset.mathjax = "true";
      script.addEventListener("error", () => reject(new Error("MathJax 加载失败")), {once: true});
      script.addEventListener("load", async () => {
        try {
          const runtime = mathJaxRuntime();
          await runtime?.startup?.promise;
          if (!runtime?.typesetPromise) throw new Error("MathJax 初始化失败");
          resolve(runtime);
        } catch (error) {
          reject(error);
        }
      }, {once: true});
      document.head.appendChild(script);
    }).catch((error) => {
      mathJaxLoad = null;
      throw error;
    });
    return mathJaxLoad;
  }

  function clearMathTypesetting(element: Element) {
    mathJaxRuntime()?.typesetClear?.([element]);
  }

  function scheduleMathTypesetting(element: Element) {
    const candidates = element.matches('.math-fragment:not([data-math-rendered="1"])')
      ? [element as HTMLElement]
      : Array.from(element.querySelectorAll<HTMLElement>('.math-fragment:not([data-math-rendered="1"])'));
    for (const candidate of candidates) {
      pendingMathElements.set(candidate, candidate.dataset.mathKey || "");
      candidate.dataset.mathPending = "1";
    }
    if (!candidates.length || mathTypesetFrame) return;
    mathTypesetFrame = window.requestAnimationFrame(() => {
      mathTypesetFrame = 0;
      const batch = [...pendingMathElements.entries()];
      pendingMathElements.clear();
      mathTypesetChain = mathTypesetChain.then(async () => {
        const current = batch.filter(([candidate, mathKey]) => candidate.isConnected && candidate.dataset.mathKey === mathKey);
        if (!current.length) return;
        const runtime = await ensureMathJax();
        const stillCurrent = current.filter(([candidate, mathKey]) => candidate.isConnected && candidate.dataset.mathKey === mathKey);
        if (!stillCurrent.length) return;
        const viewport = options.root.querySelector<HTMLElement>("#thread-viewport");
        const wasAtBottom = options.isViewportAtBottom(viewport);
        const previousScrollTop = viewport?.scrollTop || 0;
        await runtime.typesetPromise!(stillCurrent.map(([candidate]) => candidate));
        markdownRenderMetrics.mathTypesets += stillCurrent.length;
        for (const [candidate, mathKey] of stillCurrent) {
          if (candidate.isConnected && candidate.dataset.mathKey === mathKey) {
            candidate.dataset.mathRendered = "1";
            candidate.dataset.mathTypesetCount = String(Number(candidate.dataset.mathTypesetCount || "0") + 1);
            const block = candidate.closest<HTMLElement>(".markdown-block");
            if (block) block.dataset.mathTypesetCount = String(Number(block.dataset.mathTypesetCount || "0") + 1);
            delete candidate.dataset.mathPending;
          }
        }
        if (wasAtBottom) options.scrollBottom();
        else if (viewport) viewport.scrollTop = previousScrollTop;
        for (const [candidate, mathKey] of stillCurrent) if (candidate.isConnected && candidate.dataset.mathKey !== mathKey) scheduleMathTypesetting(candidate);
      }).catch((error) => {
        for (const [candidate] of batch) delete candidate.dataset.mathPending;
        console.error("MathJax typesetting failed", error);
      });
    });
  }

  return {clearMathTypesetting, renderMarkdownContainer, scheduleMathTypesetting};
}
