import type {ChatProfile} from "../shared/profile-types";
import type {AppState} from "./app-state";
import {avatarPlaceholder} from "./avatar";
import {escapeHtml} from "./html";

type IconSet = typeof import("./icons").icons;

export function createIdentitySyncView(state: AppState, dependencies: {root: HTMLElement; icons: IconSet}) {
  function syncIndicatorTitle() {
    if (!state.authenticated) return state.offline
      ? "当前离线；数据安全保存在当前浏览器"
      : "本地模式：数据仅保存在当前浏览器";
    const last = state.lastFetchAt ? new Date(state.lastFetchAt).toLocaleString() : "从未完成 fetch";
    if (state.offline) return `当前离线；本地更改安全保存在浏览器中 · 上次完成：${last}`;
    if (state.syncing) return `正在 fetch · 上次完成：${last}`;
    if (state.syncError) return `本地更改安全保存在浏览器中 · ${state.syncError} · 上次完成：${last}`;
    if (!state.initialFetchComplete) return `尚未完成首次 fetch · 上次完成：${last}`;
    return `上次 fetch：${last}`;
  }

  function syncIndicatorState() {
    if (!state.authenticated) return {className: state.offline ? "offline" : "local", label: state.offline ? "离线" : "本地"};
    if (state.offline) return {className: "offline", label: "离线"};
    if (state.syncing) return {className: "fetching", label: "同步中"};
    if (state.syncError) return {className: "error", label: "待同步"};
    if (!state.initialFetchComplete) return {className: "fetching", label: "未 fetch"};
    return {className: "synced", label: "已同步"};
  }

  function updateSyncIndicator() {
    const indicator = dependencies.root.querySelector<HTMLElement>(".identity-sync-control");
    if (!indicator) return;
    const visual = syncIndicatorState();
    indicator.className = `identity-sync-control ${visual.className}`;
    indicator.title = syncIndicatorTitle();
    indicator.setAttribute("aria-label", state.authenticated ? `个人同步仓库；${visual.label}` : `${visual.label}仓库`);
    const label = indicator.querySelector<HTMLElement>(".identity-sync-label");
    if (label) label.textContent = visual.label;
  }

  function renderIdentitySyncControl(profile: ChatProfile) {
    const visual = syncIndicatorState();
    const title = syncIndicatorTitle();
    const ariaLabel = state.authenticated ? `个人同步仓库；${visual.label}` : `${visual.label}仓库`;
    const identity = state.authenticated
      ? `<span class="identity-sync-avatar"><img class="header-avatar" src="${avatarPlaceholder(profile)}" alt="${escapeHtml(profile.name || profile.username)} 的头像" referrerpolicy="no-referrer"><i class="identity-sync-status" aria-hidden="true"></i></span>`
      : `<span class="identity-sync-avatar identity-sync-local" aria-hidden="true">${dependencies.icons.offline}<i class="identity-sync-status"></i></span>`;
    const content = `${identity}<span class="identity-sync-label">${escapeHtml(visual.label)}</span>`;
    return `<span class="identity-sync-control ${visual.className}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(title)}">${content}</span>`;
  }

  return {updateSyncIndicator, renderIdentitySyncControl};
}
