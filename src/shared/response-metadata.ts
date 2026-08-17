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
  fallbackOutputTokens?: number | undefined | null,
  firstTokenAt?: number | null
): ResponseMetadata {
  const finishedAt = performance.now();
  const durationMs = Math.max(1, Math.round(finishedAt - startedAt));
  const timeToFirstTokenMs = typeof firstTokenAt === "number"
    ? Math.max(0, Math.min(durationMs, Math.round(firstTokenAt - startedAt)))
    : null;
  const normalizedTokens = normalizeTokenCount(outputTokens) ?? normalizeTokenCount(fallbackOutputTokens);
  const streamDurationMs = Math.max(1, durationMs - (timeToFirstTokenMs ?? 0));
  const tokensPerSecond = normalizedTokens === null
    ? null
    : Math.round((normalizedTokens / (streamDurationMs / 1000)) * 10) / 10;
  return {providerId, model, durationMs, timeToFirstTokenMs, outputTokens: normalizedTokens, tokensPerSecond};
}
