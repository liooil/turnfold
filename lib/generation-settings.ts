import type {ProviderDefinition} from "./provider-types";

type JsonValue = null | string | number | boolean | JsonValue[] | {[key: string]: JsonValue};

export type ReasoningLevel = "auto" | "none" | "low" | "medium" | "high";

export type GenerationSettings = {
  reasoning: ReasoningLevel;
  showReasoningSummary: boolean;
  temperature: number | null;
  maxOutputTokens: number | null;
};

export const defaultGenerationSettings: GenerationSettings = {
  reasoning: "auto",
  showReasoningSummary: false,
  temperature: null,
  maxOutputTokens: null
};

export function normalizeGenerationSettings(value: unknown): GenerationSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const reasoning = ["auto", "none", "low", "medium", "high"].includes(String(input.reasoning))
    ? input.reasoning as ReasoningLevel
    : "auto";
  const temperature = typeof input.temperature === "number" && Number.isFinite(input.temperature)
    ? Math.min(2, Math.max(0, input.temperature))
    : null;
  const maxOutputTokens = typeof input.maxOutputTokens === "number" && Number.isFinite(input.maxOutputTokens)
    ? Math.min(1_000_000, Math.max(1, Math.floor(input.maxOutputTokens)))
    : null;
  return {
    reasoning,
    showReasoningSummary: input.showReasoningSummary === true,
    temperature,
    maxOutputTokens
  };
}

export function generationCallOptions(provider: ProviderDefinition, settings: GenerationSettings) {
  const providerOptions: Record<string, {[key: string]: JsonValue}> = {};
  if (provider.api === "openai-responses") {
    providerOptions.openai = {reasoningSummary: settings.showReasoningSummary ? "auto" : null};
  } else if (provider.api === "anthropic-messages" && settings.showReasoningSummary && settings.reasoning !== "none") {
    providerOptions.anthropic = {thinking: {type: "adaptive", display: "summarized"}};
  } else if (provider.api === "google-generative-ai" && settings.showReasoningSummary) {
    providerOptions.google = {thinkingConfig: {includeThoughts: true}};
  }
  return {
    ...(settings.reasoning !== "auto" ? {reasoning: settings.reasoning} : {}),
    ...(settings.temperature !== null ? {temperature: settings.temperature} : {}),
    ...(settings.maxOutputTokens !== null ? {maxOutputTokens: settings.maxOutputTokens} : {}),
    ...(Object.keys(providerOptions).length ? {providerOptions} : {})
  };
}
