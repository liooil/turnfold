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
