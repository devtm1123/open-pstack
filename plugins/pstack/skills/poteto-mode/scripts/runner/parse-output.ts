import { parseOpenCodeTranscript } from "./opencode.ts";
import { isAbsolute } from "node:path";
import type {
  NormalizedUsage,
  ParsedOutput,
  Provider,
} from "./types.ts";
import {
  concreteModelMatchesRollingAlias,
  isRollingClaudeAlias,
} from "./model-aliases.ts";
import {
  ProviderTerminalError,
  ProviderToolDeniedError,
  devinDenialEvidence,
} from "./provider-failure.ts";
import { OutputValidationError } from "./types.ts";
import { assessCodexTranscript } from "./codex.ts";
import { antigravityEvents, antigravitySuccessfulResult } from "./antigravity.ts";
import { parseMuseEvents } from "./muse.ts";

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

function devinAtifWriteDenied(exported: JsonObject): boolean {
  const steps = exported.steps;
  if (!Array.isArray(steps) || steps.length === 0) return false;
  const earlierFinal = steps.slice(0, -1).some((entry) => {
    const step = object(entry);
    const calls = step?.tool_calls;
    return step?.source === "agent" &&
      typeof step.message === "string" && step.message.trim().length > 0 &&
      (calls === undefined || (Array.isArray(calls) && calls.length === 0));
  });
  if (earlierFinal) return false;
  const last = object(steps.at(-1));
  if (last?.source !== "agent" || typeof last.message !== "string" ||
      !Array.isArray(last.tool_calls) || last.tool_calls.length !== 1) return false;
  const call = object(last.tool_calls[0]);
  const args = object(call?.arguments);
  const path = args?.file_path;
  if (call?.function_name !== "write" || typeof call.tool_call_id !== "string" ||
      !call.tool_call_id || typeof path !== "string" || !isAbsolute(path) ||
      typeof args?.content !== "string" ||
      Object.keys(args).sort().join(",") !== "content,file_path") return false;
  const results = object(last.observation)?.results;
  if (!Array.isArray(results) || results.length !== 1) return false;
  const result = object(results[0]);
  return result?.source_call_id === call.tool_call_id &&
    result.content === `Write access to '${path}' was denied. The user needs to grant write permission for this directory — ask them to approve the write access request or add the directory to the workspace.`;
}

function normalizedUsage(value: unknown): NormalizedUsage | null {
  const usage = object(value);
  if (usage === null) return null;
  const result: NormalizedUsage = {
    inputTokens: finiteNumber(usage.input_tokens),
    cachedInputTokens: finiteNumber(
      usage.cached_input_tokens ?? usage.cache_read_input_tokens
    ),
    cacheCreationInputTokens: finiteNumber(
      usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens
    ),
    outputTokens: finiteNumber(usage.output_tokens),
    reasoningTokens: finiteNumber(
      usage.reasoning_tokens ?? usage.reasoning_output_tokens
    ),
    totalTokens: finiteNumber(usage.total_tokens),
  };
  return Object.values(result).some((entry) => entry !== undefined)
    ? result
    : null;
}

function modelFromUsage(
  value: unknown,
  provider: Provider,
  requestedModel: string
): string | null {
  const usage = object(value);
  if (usage === null) return null;
  const models = Object.keys(usage);
  return models.find((model) =>
    reportedModelMatches(provider, requestedModel, model)
  )
    ?? models[0]
    ?? null;
}

// Claude stream-json output is the only shape that identifies the primary
// model: each main-agent assistant event carries `message.model` with an
// explicit null `parent_tool_use_id` in the result's session. Helper events
// (nonempty string owner) are accounting only, and `init.model`, argv and
// `modelUsage` never prove which model answered.
function parseClaude(stdout: string): ParsedOutput {
  const events: JsonObject[] = [];
  let malformed = false;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    const event = object(raw);
    if (event === null) malformed = true;
    else events.push(event);
  }

  let result: JsonObject | null = null;
  let results = 0;
  for (const event of events) {
    if (event.type === "result") {
      result = event;
      results += 1;
    }
  }
  if (result === null) {
    throw new OutputValidationError("claude stream did not contain a terminal result");
  }
  if (result.is_error === true) {
    throw new ProviderTerminalError("claude", "claude reported an error result", result);
  }
  if (malformed) throw new OutputValidationError("claude emitted a malformed stream event");
  if (results !== 1 || events.at(-1) !== result) {
    throw new OutputValidationError("claude stream did not end with exactly one result");
  }
  if (result.subtype !== "success" || result.is_error !== false) {
    throw new OutputValidationError("claude result was not an explicit success");
  }
  const text = nullableString(result.result);
  if (text === null) throw new OutputValidationError("claude result did not contain final text");
  const sessionId = nullableString(result.session_id);
  if (sessionId === null) throw new OutputValidationError("claude result did not identify its session");

  const primary = new Set<string>();
  for (const event of events) {
    if (event.type !== "assistant") continue;
    const owner = event.parent_tool_use_id;
    if (typeof owner === "string" && owner.length > 0) continue;
    if (owner !== null) {
      throw new OutputValidationError("claude assistant event did not declare its owner");
    }
    if (event.session_id !== sessionId) {
      throw new OutputValidationError("claude assistant event belongs to another session");
    }
    const message = object(event.message);
    if (message?.role !== "assistant") {
      throw new OutputValidationError("claude assistant event carried a non-assistant message");
    }
    const model = nullableString(message.model);
    if (model === null) {
      throw new OutputValidationError("claude primary assistant event did not report a model");
    }
    primary.add(model);
  }
  if (primary.size === 0) {
    throw new OutputValidationError("claude did not report a primary assistant model");
  }
  if (primary.size > 1) {
    throw new OutputValidationError("claude reported multiple primary models");
  }

  return {
    text,
    reportedModel: [...primary][0],
    sessionId,
    usage: normalizedUsage(result.usage),
    costUsd: finiteNumber(result.total_cost_usd) ?? null,
  };
}

function parseGrok(stdout: string, requestedModel: string): ParsedOutput {
  let result: JsonObject | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new OutputValidationError("grok emitted a non-JSON event");
    }
    const event = object(raw);
    if (event?.type === "result") result = event;
  }

  if (result === null) throw new OutputValidationError("grok result did not contain a terminal event");
  if (result.is_error === true || result.subtype !== "success") {
    throw new ProviderTerminalError("grok", "grok reported an error result", result);
  }
  const text = nullableString(result.result);
  if (text === null) throw new OutputValidationError("grok result did not contain final text");

  return {
    text,
    reportedModel: modelFromUsage(result.modelUsage, "grok", requestedModel),
    sessionId: nullableString(result.session_id),
    usage: normalizedUsage(result.usage),
    costUsd: finiteNumber(result.total_cost_usd) ?? null,
  };
}

function parseCodex(stdout: string): ParsedOutput {
  const assessment = assessCodexTranscript(stdout);
  if (assessment.kind === "failed") {
    throw new ProviderTerminalError(
      "codex",
      assessment.terminal.message ?? "codex reported a failed turn",
      assessment.terminal.event
    );
  }
  if (assessment.kind === "rejected") {
    throw new OutputValidationError(assessment.reason);
  }
  return {
    text: assessment.text,
    reportedModel: null,
    sessionId: assessment.sessionId,
    usage: normalizedUsage(assessment.terminal.event.usage),
    costUsd: null,
  };
}

function parseCursor(stdout: string): ParsedOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new OutputValidationError("cursor did not emit valid JSON");
  }
  const value = object(raw);
  if (value === null || value.type !== "result") {
    throw new OutputValidationError("cursor did not emit a terminal result envelope");
  }
  if (value.subtype !== "success" || value.is_error !== false) {
    throw new ProviderTerminalError("cursor", "cursor did not report a successful result", value);
  }
  const text = nullableString(value.result);
  if (text === null || text.trim().length === 0) throw new OutputValidationError("cursor result did not contain final text");
  const usage = object(value.usage);
  return {
    text,
    reportedModel: nullableString(value.model),
    sessionId: nullableString(value.session_id),
    usage: normalizedUsage(usage === null ? null : {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
    }),
    costUsd: finiteNumber(value.total_cost_usd) ?? null,
  };
}

function parseAntigravity(stdout: string): ParsedOutput {
  const events = antigravityEvents(stdout);
  const first = events[0];
  const last = events.at(-1);
  const init = first?.event === "init" ? object(first.init) : null;
  const result = last?.event === "result" ? object(last.result) : null;
  if (init === null || nullableString(first?.conversation_id) === null) {
    throw new OutputValidationError("antigravity stream did not begin with init");
  }
  if (events.filter((event) => event.event === "init").length !== 1 ||
      events.filter((event) => event.event === "result").length !== 1 || result === null) {
    throw new OutputValidationError("antigravity stream did not end with one result");
  }
  if (events.some((event) => event.event === "error") || result.num_turns !== 1) {
    throw new OutputValidationError("antigravity stream did not contain one completed turn");
  }
  if (result.conversation_id !== first?.conversation_id) {
    throw new OutputValidationError("antigravity conversation id changed");
  }
  if (Object.hasOwn(result, "denied_actions")) {
    if (!Array.isArray(result.denied_actions) || result.denied_actions.length === 0 ||
        result.denied_actions.some((action) => object(action) === null)) {
      throw new ProviderTerminalError("antigravity", "antigravity reported malformed denied actions", result);
    }
    throw new ProviderToolDeniedError(
      "antigravity",
      "antigravity reported denied actions",
      result,
      {
        verified: true,
        cause: "unknown",
        tool: null,
        requestedAction: null,
        evidence: "antigravity_denied_actions_present",
      },
      "child-failed"
    );
  }
  if (!antigravitySuccessfulResult(result)) {
    throw new ProviderTerminalError("antigravity", "antigravity did not report a successful result", result);
  }
  const usage = object(result.usage);
  return {
    text: (result.response as string).trim(),
    reportedModel: nullableString(init.model),
    sessionId: first.conversation_id as string,
    usage: normalizedUsage(usage === null ? null : {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      thinking_tokens: usage.thinking_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      total_tokens: usage.total_tokens,
      reasoning_tokens: usage.thinking_tokens,
      cached_input_tokens: usage.cache_read_tokens,
    }),
    costUsd: null,
  };
}

function parseMuse(stdout: string, requestedModel: string): ParsedOutput {
  const events = parseMuseEvents(stdout, requestedModel);
  if (events === null) throw new OutputValidationError("muse emitted a non-JSON event");
  const { terminal } = events;
  if (terminal === null) throw new OutputValidationError("muse result did not contain a terminal event");
  if (terminal.status !== "completed") {
    throw new ProviderTerminalError(
      "muse",
      terminal.reason ?? terminal.text ?? `muse reported ${terminal.status === "" ? "an empty terminal status" : terminal.status}`,
      { payload_type: `run.terminal.${terminal.status}`, payload: { terminal: terminal.status, text: terminal.text, reason: terminal.reason } }
    );
  }
  if (terminal.text === null) throw new OutputValidationError("muse result did not contain final text");
  return {
    text: terminal.text,
    reportedModel: events.usageModel,
    sessionId: events.sessionId,
    usage: events.usage,
    costUsd: null,
  };
}

export function parseProviderOutput(
  provider: Provider,
  stdout: string,
  stderr: string,
  requestedModel: string
): ParsedOutput {
  switch (provider) {
    case "antigravity":
      return parseAntigravity(stdout);
    case "opencode": {
      const terminal = parseOpenCodeTranscript(stdout);
      if (terminal.kind === "error") throw new ProviderTerminalError("opencode", "OpenCode reported a failed session", terminal.envelope);
      if (terminal.kind === "incomplete") throw new OutputValidationError(terminal.reason);
      return terminal.output;
    }
    case "devin": {
      const denial = devinDenialEvidence(stderr);
      if (denial !== null) {
        throw new ProviderToolDeniedError(
          "devin",
          "devin could not approve a tool in non-interactive mode",
          null,
          denial,
          "malformed-output"
        );
      }
      let exported: JsonObject | null;
      try {
        exported = object(JSON.parse(stdout));
      } catch {
        throw new OutputValidationError("devin export is not valid JSON");
      }
      if (exported?.schema_version !== "ATIF-v1.7" || !Array.isArray(exported.steps)) {
        throw new OutputValidationError("devin export has an unsupported schema");
      }
      if (devinAtifWriteDenied(exported)) {
        throw new ProviderToolDeniedError(
          "devin", "devin denied a direct write in non-interactive mode", null,
          { verified: true, cause: "permission", tool: "write", requestedAction: null,
            evidence: "devin_atif_write_permission_denied" },
          "malformed-output"
        );
      }
      const last = object(exported.steps.at(-1));
      const calls = last?.tool_calls;
      if (last?.source !== "agent" ||
          (calls !== undefined && (!Array.isArray(calls) || calls.length !== 0)) ||
          typeof last.message !== "string" || last.message.trim().length === 0) {
        throw new OutputValidationError("devin export did not end with a final agent response");
      }
      const text = last.message.trim();
      return { text, reportedModel: null, sessionId: null, usage: null, costUsd: null };
    }
    case "cursor":
      return parseCursor(stdout);
    case "claude":
      return parseClaude(stdout);
    case "codex":
      return parseCodex(stdout);
    case "grok":
      return parseGrok(stdout, requestedModel);
    case "muse":
      return parseMuse(stdout, requestedModel);
  }
}

export function reportedModelMatches(
  provider: Provider,
  requested: string,
  reported: string | null
): boolean {
  if (reported === null) return false;
  if (provider === "cursor" || provider === "antigravity") return reported === requested;
  if (provider === "claude") {
    const matchesRevision = concreteModelMatchesRollingAlias(requested, reported);
    if (isRollingClaudeAlias(requested) || matchesRevision) return matchesRevision;
  }
  if (reported === requested || reported.startsWith(`${requested}-`)) {
    return true;
  }
  return false;
}
