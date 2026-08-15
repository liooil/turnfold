import type {StoredChatMessage} from "../shared/conversation-types";
import type {AppState} from "./app-state";
import {markdownRenderMetrics} from "./markdown-renderer";
import {isViewportAtBottom, scrollBottom} from "./viewport";

type IconSet = typeof import("./icons").icons;

type MessageListDependencies = {
  root: HTMLElement;
  icons: IconSet;
  renderApp: () => void;
  renderMessage: (message: StoredChatMessage, index: number) => string;
  renderMessagesMarkup: () => string;
  displayedMessages: () => StoredChatMessage[];
  clearMathTypesetting: (element: Element) => void;
  scheduleMathTypesetting: (element: Element) => void;
};

export function createMessageListView(state: AppState, dependencies: MessageListDependencies) {
  function renderMessages(scroll = false) {
    const list = dependencies.root.querySelector<HTMLElement>("#message-list");
    if (!list) {
      dependencies.renderApp();
      return;
    }
    const viewport = dependencies.root.querySelector<HTMLElement>("#thread-viewport");
    const wasAtBottom = isViewportAtBottom(viewport);
    const previousScrollTop = viewport?.scrollTop || 0;
    const messages = dependencies.displayedMessages();
    if (!messages.length) {
      if (!list.querySelector(".welcome")) {
        dependencies.clearMathTypesetting(list);
        list.innerHTML = dependencies.renderMessagesMarkup();
      }
    } else if (list.querySelector(".welcome")) {
      dependencies.clearMathTypesetting(list);
      replaceListContent(list, dependencies.renderMessagesMarkup());
    } else {
      const visibleMessages = messages
        .map((message, index) => ({message, index}))
        .filter(({message}) => message.role === "user" || message.role === "assistant");
      const renderedMessages = Array.from(list.querySelectorAll<HTMLElement>(":scope > article[data-message-id]"));
      let prefixLength = 0;
      while (
        prefixLength < renderedMessages.length
        && prefixLength < visibleMessages.length
        && renderedMessages[prefixLength].dataset.messageId === visibleMessages[prefixLength].message.id
      ) prefixLength += 1;
      if (prefixLength === 0) {
        // Nothing to reuse: full replacement (also covers the first fill).
        const reasoningOpenStates = captureReasoningOpenStates(list);
        dependencies.clearMathTypesetting(list);
        replaceListContent(list, dependencies.renderMessagesMarkup());
        restoreReasoningOpenStates(list, reasoningOpenStates);
      } else {
        // Reuse the shared prefix: drop the stale tail, append the new suffix.
        while (list.children.length > prefixLength) {
          const tail = list.lastElementChild;
          if (!tail) break;
          if (tail instanceof HTMLElement && tail.matches("article[data-message-id]")) dependencies.clearMathTypesetting(tail);
          tail.remove();
        }
        let appended = false;
        for (let index = prefixLength; index < visibleMessages.length; index += 1) {
          const {message, index: messageIndex} = visibleMessages[index];
          const node = renderedMessageNode(message, messageIndex);
          if (node) {
            list.appendChild(node);
            dependencies.scheduleMathTypesetting(node);
            appended = true;
          }
        }
        // The freshly appended nodes already reflect the current message content;
        // only patch the last assistant message when the list was not extended.
        const last = visibleMessages.at(-1);
        const existingLast = list.lastElementChild;
        if (!appended && last?.message.role === "assistant" && existingLast instanceof HTMLElement && existingLast.dataset.messageId === last.message.id) {
          patchAssistantMessage(existingLast, last.message, last.index);
        }
      }
    }
    updateStreamingControls();
    if (scroll) {
      if (wasAtBottom) scrollBottom(dependencies.root);
      else if (viewport) viewport.scrollTop = previousScrollTop;
    }
  }

  function renderedMessageNode(message: StoredChatMessage, index: number): HTMLElement | null {
    const template = document.createElement("template");
    template.innerHTML = dependencies.renderMessage(message, index);
    const node = template.content.firstElementChild;
    return node instanceof HTMLElement ? node : null;
  }

  function replaceListContent(list: HTMLElement, markup: string) {
    list.innerHTML = markup;
    // Scanning the whole list for math candidates costs O(N) DOM reads; skip it
    // entirely when the markup contains no math placeholders.
    if (markup.includes("math-fragment")) dependencies.scheduleMathTypesetting(list);
  }

  function patchMathBlock(current: HTMLElement, desired: HTMLElement) {
    const currentFragments = new Map(
      Array.from(current.querySelectorAll<HTMLElement>(".math-fragment[data-math-key]"))
        .map((fragment) => [fragment.dataset.mathKey || "", fragment] as const)
    );
    const next = desired.cloneNode(true) as HTMLElement;
    for (const placeholder of next.querySelectorAll<HTMLElement>(".math-fragment[data-math-key]")) {
      const key = placeholder.dataset.mathKey || "";
      const preserved = currentFragments.get(key);
      if (!preserved) continue;
      placeholder.replaceWith(preserved);
      currentFragments.delete(key);
    }
    for (const obsolete of currentFragments.values()) dependencies.clearMathTypesetting(obsolete);
    current.replaceChildren(...Array.from(next.childNodes));
    current.dataset.renderKey = desired.dataset.renderKey;
    current.dataset.hasMath = desired.dataset.hasMath;
    current.dataset.blockStable = desired.dataset.blockStable;
    current.dataset.blockType = desired.dataset.blockType;
    dependencies.scheduleMathTypesetting(current);
  }

  function patchMarkdownContainer(current: HTMLElement, desired: HTMLElement) {
    const currentBlocks = Array.from(current.querySelectorAll<HTMLElement>(":scope > .markdown-block"));
    const desiredBlocks = Array.from(desired.querySelectorAll<HTMLElement>(":scope > .markdown-block"));
    const prefixMatches = currentBlocks.every((block, index) => block.dataset.blockId === desiredBlocks[index]?.dataset.blockId);
    if (!prefixMatches || currentBlocks.length > desiredBlocks.length) {
      dependencies.clearMathTypesetting(current);
      current.replaceChildren(...desiredBlocks.map((block) => block.cloneNode(true)));
      current.dataset.renderKey = desired.dataset.renderKey;
      markdownRenderMetrics.domBlocksUpdated += desiredBlocks.length;
      dependencies.scheduleMathTypesetting(current);
      return;
    }

    for (let index = 0; index < desiredBlocks.length; index += 1) {
      const desiredBlock = desiredBlocks[index];
      const currentBlock = currentBlocks[index];
      if (!currentBlock) {
        const appended = desiredBlock.cloneNode(true) as HTMLElement;
        current.appendChild(appended);
        markdownRenderMetrics.domBlocksUpdated += 1;
        dependencies.scheduleMathTypesetting(appended);
        continue;
      }
      if (currentBlock.dataset.renderKey === desiredBlock.dataset.renderKey) {
        currentBlock.dataset.blockStable = desiredBlock.dataset.blockStable;
        continue;
      }
      markdownRenderMetrics.domBlocksUpdated += 1;
      if (desiredBlock.dataset.hasMath === "1") {
        patchMathBlock(currentBlock, desiredBlock);
      } else {
        dependencies.clearMathTypesetting(currentBlock);
        currentBlock.innerHTML = desiredBlock.innerHTML;
        currentBlock.dataset.renderKey = desiredBlock.dataset.renderKey;
        currentBlock.dataset.hasMath = desiredBlock.dataset.hasMath;
        currentBlock.dataset.blockStable = desiredBlock.dataset.blockStable;
        currentBlock.dataset.blockType = desiredBlock.dataset.blockType;
        delete currentBlock.dataset.mathRendered;
      }
    }
    current.dataset.renderKey = desired.dataset.renderKey;
  }

  function patchAssistantMessage(existing: HTMLElement, message: StoredChatMessage, index: number) {
    const next = renderedMessageNode(message, index);
    if (!next) return;
    const existingContent = existing.querySelector<HTMLElement>(".assistant-content");
    const nextContent = next.querySelector<HTMLElement>(".assistant-content");
    if (!existingContent || !nextContent) return;

    const selectors = [".partial-badge", ".message-reasoning", ".aui-md", ".response-loader", ".message-error"];
    const retained = new Set<Element>();
    const changedMathElements = new Set<HTMLElement>();
    let insertionPoint = existingContent.firstElementChild;
    for (const selector of selectors) {
      const desired = nextContent.querySelector<HTMLElement>(`:scope > ${selector}`);
      let current = existingContent.querySelector<HTMLElement>(`:scope > ${selector}`);
      if (!desired) {
        if (current) {
          if (selector === ".aui-md") dependencies.clearMathTypesetting(current);
          if (current === insertionPoint) insertionPoint = current.nextElementSibling;
          current.remove();
        }
        continue;
      }
      if (!current) {
        current = desired.cloneNode(true) as HTMLElement;
        if (selector === ".aui-md") changedMathElements.add(current);
      } else if (selector === ".message-reasoning") {
        const currentBody = current.querySelector<HTMLElement>(":scope > div");
        const desiredBody = desired.querySelector<HTMLElement>(":scope > div");
        if (currentBody && desiredBody && currentBody.textContent !== desiredBody.textContent) currentBody.textContent = desiredBody.textContent;
      } else if (selector === ".aui-md" && current.dataset.renderKey !== desired.dataset.renderKey) {
        patchMarkdownContainer(current, desired);
      } else if (selector === ".message-error" && current.textContent !== desired.textContent) {
        current.textContent = desired.textContent;
      }
      if (current !== insertionPoint) existingContent.insertBefore(current, insertionPoint);
      insertionPoint = current.nextElementSibling;
      retained.add(current);
    }
    for (const child of Array.from(existingContent.children)) {
      if (!retained.has(child)) child.remove();
    }

    const existingFooter = existing.querySelector<HTMLElement>(".message-footer");
    const nextFooter = next.querySelector<HTMLElement>(".message-footer");
    if (existingFooter && nextFooter && existingFooter.innerHTML !== nextFooter.innerHTML) existingFooter.innerHTML = nextFooter.innerHTML;
    for (const element of changedMathElements) dependencies.scheduleMathTypesetting(element);
  }

  let streamingButtonsDisabled = false;

  function updateStreamingControls() {
    const composer = dependencies.root.querySelector<HTMLFormElement>("#composer");
    const composerActions = composer?.querySelector<HTMLElement>(".composer-actions") || null;
    const button = dependencies.root.querySelector<HTMLButtonElement>(".send-button");
    if (button) {
      button.type = "submit";
      button.dataset.action = "send";
      button.setAttribute("aria-label", state.streaming ? "排队发送" : "发送消息");
      button.disabled = false;
      if (button.innerHTML !== dependencies.icons.send) button.innerHTML = dependencies.icons.send;
    }
    let stopButton = composer?.querySelector<HTMLButtonElement>(".stop-button") || null;
    if (state.streaming && composer && composerActions && !stopButton) {
      composerActions.insertAdjacentHTML("afterbegin", `<button class="stop-button" type="button" data-action="stop" aria-label="停止生成">${dependencies.icons.stop}</button>`);
      stopButton = composer.querySelector<HTMLButtonElement>(".stop-button");
    }
    if (!state.streaming) stopButton?.remove();
    // Disabling/enabling every message button is an O(N) DOM scan; only do it
    // when the streaming state actually flips. Nodes rendered while streaming
    // already carry the disabled attribute from renderMessage.
    if (state.streaming !== streamingButtonsDisabled) {
      streamingButtonsDisabled = state.streaming;
      dependencies.root.querySelectorAll<HTMLButtonElement>('[data-action="regenerate-message"]').forEach((button) => {
        button.disabled = state.streaming;
      });
      dependencies.root.querySelectorAll<HTMLButtonElement>('[data-action="edit-message"]').forEach((button) => {
        button.disabled = state.streaming;
      });
    }
  }

  function captureReasoningOpenStates(list: HTMLElement) {
    const states = new Map<string, boolean>();
    list.querySelectorAll<HTMLElement>("article[data-message-id] details.message-reasoning").forEach((details) => {
      const article = details.closest<HTMLElement>("article[data-message-id]");
      if (!article) return;
      const id = article.dataset.messageId || "";
      states.set(id, details.hasAttribute("open"));
    });
    return states;
  }

  function restoreReasoningOpenStates(list: HTMLElement, states: Map<string, boolean>) {
    list.querySelectorAll<HTMLElement>("article[data-message-id] details.message-reasoning").forEach((details) => {
      const article = details.closest<HTMLElement>("article[data-message-id]");
      if (!article) return;
      const id = article.dataset.messageId || "";
      const open = states.get(id);
      if (open === undefined) return;
      if (open) details.setAttribute("open", "open");
      else details.removeAttribute("open");
    });
  }

  function scheduleMessagesRender(scroll = true) {
    if (state.renderFrame) return;
    state.renderFrame = window.requestAnimationFrame(() => {
      state.renderFrame = 0;
      renderMessages(scroll);
    });
  }

  return {renderMessages, scheduleMessagesRender, updateStreamingControls};
}
