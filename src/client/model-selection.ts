import type {ReasoningLevel} from "../shared/generation-settings";
import type {ProviderModel, ProviderProtocol} from "../shared/provider-types";
import type {AppState, ChatProvider} from "./app-state";
import {compactModelName} from "./model-display";
import {icons} from "./icons";

export type ModelChoice = {provider: ChatProvider; model: ProviderModel; key: string};

export function providerProtocolLabel(protocol: ProviderProtocol) {
  if (protocol === "openai-chat") return "OpenAI Chat";
  if (protocol === "openai-responses") return "OpenAI Responses";
  if (protocol === "anthropic") return "Anthropic";
  return "Google";
}

export function option(value: string, label: string, selected: string) {
  return `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`;
}

export function createModelSelection(state: AppState, escapeHtml: (value: unknown) => string) {
  function settingsForProvider(item: ChatProvider) {
    const saved = window.localStorage.getItem(`turnfold-model:${item.id}`) || "";
    const model = item.models.some((candidate) => candidate.id === saved)
      ? saved
      : item.models.some((candidate) => candidate.id === item.defaultModel) ? item.defaultModel : item.models[0]?.id || "";
    return {model};
  }

  function rememberModel(providerId: string, model: string) {
    if (!providerId || !model) return;
    const key = `${providerId}/${model}`;
    state.recentModelKeys = [key, ...state.recentModelKeys.filter((item) => item !== key)].slice(0, 20);
    window.localStorage.setItem("turnfold-recent-models", JSON.stringify(state.recentModelKeys));
  }

  function availableModelChoices(): ModelChoice[] {
    return state.config?.providers.flatMap((item) => item.models.map((model) => ({provider: item, model, key: `${item.id}/${model.id}`}))) || [];
  }

  function renderEffortControl(name: string) {
    const options: Array<[ReasoningLevel, string]> = [["auto", "自动"], ["none", "关闭"], ["low", "低"], ["medium", "中"], ["high", "高"]];
    return `<div class="effort-control"><div class="effort-heading"><strong>Effort</strong><small>控制模型的思考强度</small></div><div class="effort-options" role="radiogroup" aria-label="Effort">${options.map(([value, label]) => `<label><input type="radio" name="${name}" value="${value}" data-setting="reasoning"${state.generationSettings.reasoning === value ? " checked" : ""}><span>${label}</span></label>`).join("")}</div></div>`;
  }

  function renderModelOption(choice: ModelChoice) {
    const active = choice.provider.id === state.providerId && choice.model.id === state.model;
    const displayName = compactModelName(choice.model.name || choice.model.id);
    const detail = displayName === choice.model.id ? choice.provider.name : `${choice.model.id} · ${choice.provider.name}`;
    return `<button class="model-option${active ? " active" : ""}" type="button" data-action="choose-model" data-provider="${escapeHtml(choice.provider.id)}" data-model="${escapeHtml(choice.model.id)}"><span><strong>${escapeHtml(displayName)}</strong><small title="${escapeHtml(choice.model.id)}">${escapeHtml(detail)}</small></span><small>${escapeHtml(providerProtocolLabel(choice.provider.protocol))}</small></button>`;
  }

  function quickModelChoices(choices: ModelChoice[]) {
    const activeKey = `${state.providerId}/${state.model}`;
    const preferredKeys = [activeKey, ...state.recentModelKeys, ...(state.config?.providers.map((item) => `${item.id}/${item.defaultModel}`) || [])];
    const selected: ModelChoice[] = [];
    for (const key of preferredKeys) {
      const choice = choices.find((item) => item.key === key);
      if (choice && !selected.includes(choice)) selected.push(choice);
    }
    for (const choice of choices) if (selected.length < 6 && !selected.includes(choice)) selected.push(choice);
    return selected.slice(0, 6);
  }

  function renderModelPicker() {
    const active = state.config?.providers.find((item) => item.id === state.providerId);
    if (!active || !state.config) return `<button class="model-picker-empty" type="button" data-action="open-provider-settings">${state.config?.providers.length ? "选择 Provider" : "配置 Provider"}</button>`;
    const activeModelName = compactModelName(active.models.find((model) => model.id === state.model)?.name || state.model);
    const choices = quickModelChoices(availableModelChoices());
    return `<details class="model-picker"><summary aria-label="模型和 Effort"><span class="picker-label">${escapeHtml(activeModelName)}</span><span class="picker-icons"><i class="picker-chevron">${icons.down}</i></span></summary><div class="model-menu"><section class="quick-models"><div class="quick-config-heading"><strong>模型</strong><small>当前与最近使用</small></div><div class="quick-model-list">${choices.map(renderModelOption).join("")}</div></section>${renderEffortControl("quick-effort")}<button class="open-settings-button" type="button" data-action="open-settings">${icons.settings}<span><strong>打开全部设置</strong><small>模型、生成参数与 Provider</small></span></button></div></details>`;
  }

  return {availableModelChoices, rememberModel, renderEffortControl, renderModelOption, renderModelPicker, settingsForProvider};
}
