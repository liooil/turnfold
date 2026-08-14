import type {ConversationSummary} from "../shared/conversation-types";
import type {AppState} from "./app-state";
import {icons} from "./icons";
import {untitledConversationLabel} from "../shared/conversation-title";

type HistoryTreeNode = {
  segment: string;
  conversations: ConversationSummary[];
  children: Map<string, HistoryTreeNode>;
};

export function createHistoryView(state: AppState, escapeHtml: (value: unknown) => string) {
  function historyItem(item: ConversationSummary, label = item.name, depth = 0) {
    const displayLabel = String(label || "").trim() || untitledConversationLabel;
    const modelLabel = item.model ? `${item.providerId || "Provider"} · ${item.model}` : "未配置模型";
    return `<article class="history-item${item.id === state.conversation?.id ? " active" : ""}" data-dom-key="history:${escapeHtml(item.id)}" style="--history-depth:${depth}"><button class="history-select" type="button" data-action="select-conversation" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(displayLabel)}</strong><small>${escapeHtml(modelLabel)}</small></button><button class="history-rename" type="button" data-action="rename-conversation" data-id="${escapeHtml(item.id)}" aria-label="重命名 ${escapeHtml(displayLabel)}">${icons.edit}</button><button class="history-delete" type="button" data-action="delete-conversation" data-id="${escapeHtml(item.id)}" aria-label="删除 ${escapeHtml(displayLabel)}">${icons.trash}</button></article>`;
  }

  function renderHistoryItems() {
    if (!state.historyTree) return state.conversations.map((item) => historyItem(item)).join("");
    const rootNode: HistoryTreeNode = {segment: "", conversations: [], children: new Map()};
    for (const conversation of state.conversations) {
      const segments = String(conversation.name || "").split("/").filter(Boolean);
      let node = rootNode;
      for (const segment of segments) {
        let child = node.children.get(segment);
        if (!child) {
          child = {segment, conversations: [], children: new Map()};
          node.children.set(segment, child);
        }
        node = child;
      }
      node.conversations.push(conversation);
    }
    const renderNode = (node: HistoryTreeNode, depth: number): string => {
      const children = [...node.children.values()].sort((left, right) => left.segment.localeCompare(right.segment));
      const rows = node.conversations.map((item) => historyItem(item, node.segment || item.name, depth)).join("");
      const folder = children.length && node.segment
        ? `<div class="history-folder" style="--history-depth:${depth}">${escapeHtml(node.segment)}</div>`
        : "";
      return `${folder}${rows}${children.map((child) => renderNode(child, node.segment ? depth + 1 : depth)).join("")}`;
    };
    return renderNode(rootNode, 0);
  }

  function renderHistory() {
    const transferMenu = `<details class="history-transfer"><summary aria-label="导入或导出会话">${icons.transfer}</summary><div class="history-transfer-menu"><button type="button" data-action="import-session">${icons.upload}<span><strong>导入</strong><small>文件、ZIP 或本地文件夹</small></span></button><hr><button type="button" data-action="export-session" data-format="turnfold">${icons.transfer}<span><strong>Turnfold 完整备份</strong><small>整个本地仓库、分支和草稿</small></span></button><button type="button" data-action="export-session" data-format="codex"><span class="format-mark">CX</span><span><strong>Codex CLI JSONL</strong><small>导出当前分支</small></span></button><button type="button" data-action="export-session" data-format="claude"><span class="format-mark">CL</span><span><strong>Claude Code JSONL</strong><small>导出当前消息树</small></span></button><button type="button" data-action="export-session" data-format="omp"><span class="format-mark">OP</span><span><strong>OMP JSONL</strong><small>导出当前消息树</small></span></button></div></details>`;
    return `<button class="history-backdrop${state.historyOpen ? " open" : ""}" type="button" aria-label="关闭历史记录" data-action="close-history"></button><aside class="history-sidebar${state.historyOpen ? " open" : ""}" aria-label="聊天历史"><div class="history-heading"><strong>聊天历史</strong><div>${transferMenu}<button type="button" data-action="toggle-history-tree" aria-label="${state.historyTree ? "平铺显示" : "树状显示"}">${state.historyTree ? icons.list : icons.tree}</button><button type="button" data-action="new-conversation" aria-label="新对话">${icons.plus}</button><button class="history-close" type="button" data-action="close-history" aria-label="关闭历史记录">${icons.close}</button></div></div><div class="history-list">${renderHistoryItems()}</div></aside>`;
  }

  return {renderHistory, renderHistoryItems};
}
