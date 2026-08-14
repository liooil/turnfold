import type {ResponseMetadata} from "./conversation-types";

function normalizeTokenCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  if (typeof value === "bigint" && value >= 0n) return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return null;
}

export function responseMetadata(
  providerId: string,
  model: string,
  startedAt: number,
  outputTokens: number | undefined | null,
  fallbackOutputTokens?: number | undefined | null
): ResponseMetadata {
  const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
  const normalizedTokens = normalizeTokenCount(outputTokens) ?? normalizeTokenCount(fallbackOutputTokens);
  const tokensPerSecond = normalizedTokens === null
    ? null
    : Math.round((normalizedTokens / (durationMs / 1000)) * 10) / 10;
  return {providerId, model, durationMs, outputTokens: normalizedTokens, tokensPerSecond};
}
