import type { NormalizedUsage } from "./types.ts";

export const MUSE_PREFLIGHT_PROMPT = "Reply with exactly: OK";

const MUSE_AUTH_ERROR_RE = /missing meta credentials/i;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface MuseTerminal {
  readonly status: string;
  readonly text: string | null;
  readonly reason: string | null;
}

export interface MuseEvents {
  readonly terminal: MuseTerminal | null;
  readonly usageModel: string | null;
  readonly usage: NormalizedUsage | null;
  readonly sessionId: string | null;
}

function matchesRequested(requested: string, reported: string): boolean {
  return reported === requested || reported.startsWith(`${requested}-`);
}

// Strict mode rejects the whole stream on a non-JSON line (output parsing,
// preflight pass). Lenient mode skips unparsable lines (failure
// classification over combined stdout/stderr captures).
function scanMuseEvents(text: string, requested: string, strict: boolean): MuseEvents | null {
  let terminal: MuseTerminal | null = null;
  let usageModel: string | null = null;
  let usage: NormalizedUsage | null = null;
  let sessionId: string | null = null;

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      if (strict) return null;
      continue;
    }
    const event = object(raw);
    if (event === null) {
      if (strict) return null;
      continue;
    }
    const payload = object(event.payload);
    const payloadType = typeof event.payload_type === "string" ? event.payload_type : "";
    if (payloadType.startsWith("run.terminal.") && payload !== null) {
      terminal = {
        status: typeof payload.terminal === "string" ? payload.terminal : "",
        text: nullableString(payload.text),
        reason: nullableString(payload.reason),
      };
    } else if (payloadType === "run.usage" && payload !== null) {
      const models = Array.isArray(payload.models) ? payload.models : [];
      const entries = models
        .map((entry) => object(entry))
        .filter((entry): entry is JsonObject =>
          entry !== null && typeof entry.model === "string" && entry.model.length > 0);
      const match = entries.find((entry) => matchesRequested(requested, entry.model as string))
        ?? entries[0]
        ?? null;
      if (match !== null) {
        usageModel = match.model as string;
        const candidate: NormalizedUsage = {
          inputTokens: finiteNumber(match.input_tokens),
          cachedInputTokens: finiteNumber(match.cached_tokens),
          outputTokens: finiteNumber(match.output_tokens),
          reasoningTokens: finiteNumber(match.reasoning_tokens),
        };
        if (Object.values(candidate).some((value) => value !== undefined)) usage = candidate;
      }
    }
    if (sessionId === null) {
      const stream = object(event.stream);
      if (stream?.kind === "session" && typeof stream.id === "string" && stream.id.length > 0) {
        sessionId = stream.id;
      }
    }
  }
  return { terminal, usageModel, usage, sessionId };
}

export function parseMuseEvents(stdout: string, requested: string): MuseEvents | null {
  return scanMuseEvents(stdout, requested, true);
}

// The CLI has no login-status or model-list command, so the preflight is one
// tiny model call. It passes only when the probe's usage names the requested
// model: an unknown model either exits 0 with an empty usage model list or
// fails with `model ... does not exist`.
export function musePreflightPassed(model: string, stdout: string, stderr: string): boolean {
  if (MUSE_AUTH_ERROR_RE.test(`${stdout}\n${stderr}`)) return false;
  const events = parseMuseEvents(stdout, model);
  if (events === null) return false;
  const { terminal, usageModel } = events;
  return terminal?.status === "completed" && terminal.text !== null && usageModel !== null
    && matchesRequested(model, usageModel);
}

// A completed probe that did not serve the requested model is an
// unavailable-model failure, not an authentication failure.
export function museCompletedWithoutModel(model: string, combined: string): boolean {
  const events = scanMuseEvents(combined, model, false);
  if (events?.terminal?.status !== "completed") return false;
  const { usageModel } = events;
  return usageModel === null || !matchesRequested(model, usageModel);
}

export function museTerminalCompleted(stdout: string, requested: string): boolean {
  return scanMuseEvents(stdout, requested, false)?.terminal?.status === "completed";
}
