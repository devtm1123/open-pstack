import { parseOpenCodeTranscript } from "./opencode.ts";
import type { Provider, ToolDenial } from "./types.ts";
import { assessCodexTranscript, codexTerminalEvent, type CodexTerminal } from "./codex.ts";
import { antigravityEvents, antigravitySuccessfulResult } from "./antigravity.ts";
import { museTerminalCompleted } from "./muse.ts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export class ProviderTerminalError extends Error {
  readonly provider: Provider;
  readonly envelope: unknown;
  constructor(provider: Provider, message: string, envelope: unknown) {
    super(message);
    this.name = "ProviderTerminalError";
    this.provider = provider;
    this.envelope = envelope;
  }
}

// A terminal provider error backed by the provider's own recorded tool
// denial. `receiptStatus` preserves the status the lane would have reported
// without denial evidence so normalization stays honest about what happened;
// the denial itself is attached to the receipt additively.
export class ProviderToolDeniedError extends ProviderTerminalError {
  readonly denial: ToolDenial;
  readonly receiptStatus: "child-failed" | "malformed-output";
  constructor(
    provider: Provider,
    message: string,
    envelope: unknown,
    denial: ToolDenial,
    receiptStatus: "child-failed" | "malformed-output"
  ) {
    super(provider, message, envelope);
    this.name = "ProviderToolDeniedError";
    this.denial = denial;
    this.receiptStatus = receiptStatus;
  }
}

export function antigravityHookDenial(stdout: string): ToolDenial | null {
  for (const event of antigravityEvents(stdout)) {
    if (event.event !== "step_update") continue;
    const step = object(event.step_update);
    const error = object(step?.tool_info)?.error;
    const message = typeof error === "string" ? error : object(error)?.message;
    if (typeof message !== "string") continue;
    if (/^(?:(?:tool call )?denied by pre-tool hook:|JSON hook [^\n]* failed:|failed to unmarshal result from hook jsonhook__[^\n]* via protojson:)/.test(message)) {
      return { verified: true, cause: "permission", tool: typeof step?.tool_name === "string" ? step.tool_name : null, requestedAction: null, evidence: "Antigravity native tool error reported a hook denial or hook execution failure" };
    }
  }
  return null;
}

// Devin's headless rejection frame is provider-owned evidence that a tool
// call needed a confirmation nobody could give. It proves permission was
// required without proving which operation was refused, so the tool and
// requested action stay null rather than being guessed from worker prose.
export const DEVIN_TOOL_DENIAL_RE =
  /^warning: rejected a tool call that requires confirmation\./im;

export function devinDenialEvidence(stderr: string): ToolDenial | null {
  const match = DEVIN_TOOL_DENIAL_RE.exec(stderr);
  if (match === null) return null;
  return {
    verified: true,
    cause: "permission",
    tool: null,
    requestedAction: null,
    evidence: match[0],
  };
}

// Denial evidence visible in stderr without parsing the provider protocol.
// Devin is the only implemented adapter; other providers either carry denial
// evidence in their terminal envelope (handled where the envelope is parsed)
// or have no proven denial channel and fail closed.
export function providerDenialEvidence(
  provider: Provider,
  stderr: string
): ToolDenial | null {
  return provider === "devin" ? devinDenialEvidence(stderr) : null;
}

// Canonical Codex terminal quota diagnostics (normalized). Only the
// UsageLimitReached/QuotaExceeded Display strings count — UsageNotIncluded is
// an entitlement gate, RateLimitExceeded is retryable, and
// ServerOverloaded/SessionBudgetExceeded are not account quota. Source
// provenance for every adapter lives in references/provider-dispatch.md.
const CODEX_QUOTA_DIAGNOSTICS = [
  "you've hit your usage limit",
  "your workspace is out of credits.",
  "you hit your spend cap set",
  "quota exceeded. check your plan and billing details.",
] as const;

// Codex continues these diagnostics with "." or " " ("usage limit. Visit ...",
// "spend cap set by ..."); anything else is an unproven continuation.
const CODEX_DIAGNOSTIC_SEPARATORS = [".", " "] as const;

function normalizeDiagnosticText(message: string): string {
  return message.trim().toLowerCase().replaceAll("’", "'");
}

function beginsWithDiagnostic(
  text: string,
  diagnostic: string,
  separators: readonly string[]
): boolean {
  if (!text.startsWith(diagnostic)) return false;
  const rest = text.slice(diagnostic.length);
  return (
    rest.length === 0 ||
    separators.some((separator) => rest.startsWith(separator))
  );
}

function stderrLines(stderr: string): string[] {
  return stderr
    .replaceAll(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .map((line) => line.replaceAll("\r", "").trim())
    .filter((line) => line.length > 0);
}

// A caller-provided terminal envelope is trusted: a recognizably successful
// terminal frame means the attempt did not die of exhaustion and must veto any
// channel diagnostic. A result envelope counts only through the provider's
// declared success subtype — a bare is_error:false object proves nothing.
function isSuccessfulTerminalEnvelope(value: unknown): boolean {
  const event = object(value);
  if (event === null) return false;
  if (event.type === "turn.completed") return true;
  if (event.type === "result") {
    return event.subtype === "success" && event.is_error !== true;
  }
  return false;
}

// Only these source-proven Codex wrappers may expose a diagnostic after their
// ": " boundary: exec retries surface the final failure as
// "stream disconnected after retries: {message}". Any other "{context}: "
// prefix (authentication, rate limit, model) is unproven, so a wrapped
// diagnostic inside it never classifies. Quoted or embedded occurrences still
// do not match.
const CODEX_MESSAGE_WRAPPERS = ["stream disconnected after retries: "] as const;

function isCodexQuotaMessage(message: string): boolean {
  const normalized = normalizeDiagnosticText(message);
  const segments = [normalized];
  for (const wrapper of CODEX_MESSAGE_WRAPPERS) {
    if (normalized.startsWith(wrapper)) {
      segments.push(normalized.slice(wrapper.length));
    }
  }
  return segments.some((segment) =>
    CODEX_QUOTA_DIAGNOSTICS.some((diagnostic) =>
      beginsWithDiagnostic(segment, diagnostic, CODEX_DIAGNOSTIC_SEPARATORS)
    )
  );
}

// The backend `subscription:free-usage-exhausted` code maps uniquely to this
// message; the terminal error shape is {type:"result",
// subtype:"error_during_execution", is_error:true, errors:[message]}.
const GROK_FREE_USAGE_MESSAGE = normalizeDiagnosticText(
  "You\u2019ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build"
);

function grokTerminalResult(events: readonly JsonObject[]): JsonObject | null {
  let result: JsonObject | null = null;
  for (const event of events) {
    if (event.type === "result") result = event;
  }
  return result;
}

function jsonObjects(text: string): JsonObject[] {
  const candidates: JsonObject[] = [];
  const tryParse = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    try {
      const parsed = object(JSON.parse(trimmed));
      if (parsed !== null) candidates.push(parsed);
    } catch {
    }
  };
  tryParse(text);
  for (const line of text.split("\n")) tryParse(line);
  return candidates;
}

export interface TerminalClassification {
  readonly status: "usage-exhausted" | null;
  readonly code: string | null;
  readonly evidence: string;
}

const UNKNOWN: TerminalClassification = { status: null, code: null, evidence: "" };

// Every adapter sees the same process outcome: the raw captures, the child
// exit code, and — only when the caller already parsed a trusted terminal
// envelope (a thrown ProviderTerminalError) — that envelope. An adapter reads
// only the channels its provider protocol actually carries; unrecognized
// input stays UNKNOWN and never triggers fallback.
export interface ProviderProcessOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly terminalEnvelope?: unknown;
}

interface QuotaAdapter {
  classify(outcome: ProviderProcessOutcome): TerminalClassification;
  succeeded(outcome: ProviderProcessOutcome): boolean;
}

function classifyCodexTerminal(terminal: CodexTerminal): TerminalClassification {
  if (terminal.kind === "completed" || terminal.message === null) return UNKNOWN;
  if (!isCodexQuotaMessage(terminal.message)) return UNKNOWN;
  return {
    status: "usage-exhausted",
    code: "codex_usage_limit_exceeded",
    evidence: JSON.stringify(terminal.event).slice(0, 2_000),
  };
}

function classifyGrokResult(result: JsonObject): TerminalClassification {
  if (
    result.type !== "result" ||
    result.subtype !== "error_during_execution" ||
    result.is_error !== true ||
    !Array.isArray(result.errors)
  ) {
    return UNKNOWN;
  }
  const quota = result.errors.some(
    (entry) =>
      typeof entry === "string" &&
      normalizeDiagnosticText(entry) === GROK_FREE_USAGE_MESSAGE
  );
  if (!quota) return UNKNOWN;
  return {
    status: "usage-exhausted",
    code: "grok_free_usage_exhausted",
    evidence: JSON.stringify(result).slice(0, 2_000),
  };
}

const codexAdapter: QuotaAdapter = {
  classify(outcome) {
    if (outcome.terminalEnvelope !== undefined) {
      const event = object(outcome.terminalEnvelope);
      if (event === null || (event.type !== "turn.failed" && event.type !== "error")) {
        return UNKNOWN;
      }
      const terminal = codexTerminalEvent([event]);
      return terminal === null ? UNKNOWN : classifyCodexTerminal(terminal);
    }
    const terminal = assessCodexTranscript(outcome.stdout).terminal;
    return terminal === null ? UNKNOWN : classifyCodexTerminal(terminal);
  },
  succeeded(outcome) {
    if (outcome.terminalEnvelope !== undefined) {
      const event = object(outcome.terminalEnvelope);
      return event !== null && codexTerminalEvent([event])?.kind === "completed";
    }
    return assessCodexTranscript(outcome.stdout).terminal?.kind === "completed";
  },
};

const grokAdapter: QuotaAdapter = {
  classify(outcome) {
    if (outcome.terminalEnvelope !== undefined) {
      const event = object(outcome.terminalEnvelope);
      return event === null ? UNKNOWN : classifyGrokResult(event);
    }
    const result = grokTerminalResult(jsonObjects(outcome.stdout));
    return result === null ? UNKNOWN : classifyGrokResult(result);
  },
  succeeded(outcome) {
    if (outcome.terminalEnvelope !== undefined) {
      return isSuccessfulTerminalEnvelope(outcome.terminalEnvelope);
    }
    const result = grokTerminalResult(jsonObjects(outcome.stdout));
    return result !== null && isSuccessfulTerminalEnvelope(result);
  },
};

// Claude's terminal quota proof is the complete errored api_error result
// envelope (verified against a captured real exhaustion); subtype alone or a
// bare 429 never classify, and a later successful result supersedes. The
// composer renders `You've hit your ${name}${tail}` and
// `You're out of usage credits${tail}` where tail is empty or begins " · ",
// so that separator or end-of-text is the only proven diagnostic boundary.
// Unproven names, `errors`-carrying subtypes, entitlement/seat-tier text, and
// non-429 api_error frames fail closed.
const CLAUDE_QUOTA_DIAGNOSTICS = [
  "you've hit your session limit",
  "you've hit your weekly limit",
  "you've hit your opus limit",
  "you've hit your sonnet limit",
  "you've hit your fable limit",
  "you've hit your usage credit limit",
  "you've hit your usage limit",
  "you've hit your limit",
  "you've hit your team's shared budget",
  "you've hit your monthly spend limit",
  "you've hit your org's monthly spend limit",
  "you've hit your org's monthly usage limit",
  "you're out of usage credits",
] as const;

const CLAUDE_DIAGNOSTIC_SEPARATORS = [" \u00b7 "] as const;

function isClaudeQuotaDiagnostic(message: string): boolean {
  const normalized = normalizeDiagnosticText(message);
  return CLAUDE_QUOTA_DIAGNOSTICS.some((diagnostic) =>
    beginsWithDiagnostic(normalized, diagnostic, CLAUDE_DIAGNOSTIC_SEPARATORS)
  );
}

function classifyClaudeResult(result: JsonObject): TerminalClassification {
  if (
    result.type !== "result" ||
    result.is_error !== true ||
    result.terminal_reason !== "api_error" ||
    result.api_error_status !== 429 ||
    typeof result.result !== "string" ||
    !isClaudeQuotaDiagnostic(result.result)
  ) {
    return UNKNOWN;
  }
  return {
    status: "usage-exhausted",
    code: "claude_usage_limit_exceeded",
    evidence: JSON.stringify(result).slice(0, 2_000),
  };
}

function claudeTerminalResult(events: readonly JsonObject[]): JsonObject | null {
  let result: JsonObject | null = null;
  for (const event of events) {
    if (event.type === "result") result = event;
  }
  return result;
}

const claudeAdapter: QuotaAdapter = {
  classify(outcome) {
    if (outcome.terminalEnvelope !== undefined) {
      const event = object(outcome.terminalEnvelope);
      return event === null ? UNKNOWN : classifyClaudeResult(event);
    }
    const result = claudeTerminalResult(jsonObjects(outcome.stdout));
    return result === null ? UNKNOWN : classifyClaudeResult(result);
  },
  succeeded(outcome) {
    if (outcome.terminalEnvelope !== undefined) {
      return isSuccessfulTerminalEnvelope(outcome.terminalEnvelope);
    }
    const result = claudeTerminalResult(jsonObjects(outcome.stdout));
    return result !== null && isSuccessfulTerminalEnvelope(result);
  },
};

// Devin `--print` failures surface as one stderr `Error: <Display>` frame at
// a nonzero exit. The quota contract is exactly `Error: Quota exhausted:
// <canonical>` or `Error: <canonical>`: the `Quota exhausted:` prefix alone
// can wrap unrelated detail, a canonical sentence nested inside another
// Display (auth, rate, transport) is not the top-level frame, and multiple
// `Error:` frames are ambiguous. A trusted successful terminal envelope
// vetoes; Devin has no proven stdout result protocol (the ATIF transcript is
// a separate export file), so an envelope can only veto, never prove quota.
const DEVIN_QUOTA_PREFIX = "quota exhausted:";
const DEVIN_CAP_SENTENCES = [
  "you've reached your monthly usage limit. wait for the limit to reset next month.",
  "your organization has reached its monthly usage limit. ask an account admin to raise it, or wait for the limit to reset next month.",
  "usage quota has been exhausted",
] as const;

function isDevinQuotaDetail(detail: string): boolean {
  const inner = detail.startsWith(DEVIN_QUOTA_PREFIX)
    ? detail.slice(DEVIN_QUOTA_PREFIX.length).trim()
    : detail;
  return (DEVIN_CAP_SENTENCES as readonly string[]).some(
    (sentence) => inner === sentence
  );
}

const devinAdapter: QuotaAdapter = {
  succeeded(outcome) {
    return (
      outcome.terminalEnvelope !== undefined &&
      isSuccessfulTerminalEnvelope(outcome.terminalEnvelope)
    );
  },
  classify(outcome) {
    if (
      outcome.terminalEnvelope !== undefined &&
      isSuccessfulTerminalEnvelope(outcome.terminalEnvelope)
    ) {
      return UNKNOWN;
    }
    if (outcome.exitCode === null || outcome.exitCode === 0) return UNKNOWN;
    const frames = stderrLines(outcome.stderr).filter((line) =>
      line.startsWith("Error:")
    );
    if (frames.length !== 1) return UNKNOWN;
    const detail = normalizeDiagnosticText(frames[0].slice("Error:".length));
    if (!isDevinQuotaDetail(detail)) return UNKNOWN;
    return {
      status: "usage-exhausted",
      code: "devin_quota_exhausted",
      evidence: outcome.stderr.trim().slice(0, 2_000),
    };
  },
};

// Cursor's headless error path prints a single `ClassError: <message>`
// frame on stderr and exits nonzero; success writes a result envelope on
// stdout. FREE_USER_USAGE_LIMIT and PRO_USER_USAGE_LIMIT share
// ActionRequiredError with rate-limit, login, payment, and pro-only errors,
// so the class alone proves nothing: exactly one error frame is required
// (multiple frames are contradictory) and its message must begin with the
// documented cap diagnostic at a separator boundary. A successful stdout
// result envelope or trusted terminal envelope vetoes; invented structured
// codes and generic upgrade/rate/auth strings never classify.
const CURSOR_QUOTA_DIAGNOSTIC = "you've hit your usage limit";
const CURSOR_DIAGNOSTIC_SEPARATORS = [" ", "."] as const;
const CURSOR_ERROR_CLASS = "ActionRequiredError:";
const CURSOR_ERROR_FRAME = /^\S*Error:/;

const cursorAdapter: QuotaAdapter = {
  succeeded(outcome) {
    if (
      outcome.terminalEnvelope !== undefined &&
      isSuccessfulTerminalEnvelope(outcome.terminalEnvelope)
    ) {
      return true;
    }
    for (const event of jsonObjects(outcome.stdout)) {
      if (
        event.type === "result" &&
        event.subtype === "success" &&
        event.is_error === false
      ) {
        return true;
      }
    }
    return false;
  },
  classify(outcome) {
    if (
      outcome.terminalEnvelope !== undefined &&
      isSuccessfulTerminalEnvelope(outcome.terminalEnvelope)
    ) {
      return UNKNOWN;
    }
    if (outcome.exitCode === null || outcome.exitCode === 0) return UNKNOWN;
    for (const event of jsonObjects(outcome.stdout)) {
      if (
        event.type === "result" &&
        event.subtype === "success" &&
        event.is_error === false
      ) {
        return UNKNOWN;
      }
    }
    const frames = stderrLines(outcome.stderr).filter((line) =>
      CURSOR_ERROR_FRAME.test(line)
    );
    if (frames.length !== 1) return UNKNOWN;
    const frame = frames[0];
    if (!frame.startsWith(CURSOR_ERROR_CLASS)) return UNKNOWN;
    const detail = normalizeDiagnosticText(
      frame.slice(CURSOR_ERROR_CLASS.length)
    );
    if (
      !beginsWithDiagnostic(
        detail,
        CURSOR_QUOTA_DIAGNOSTIC,
        CURSOR_DIAGNOSTIC_SEPARATORS
      )
    ) {
      return UNKNOWN;
    }
    return {
      status: "usage-exhausted",
      code: "cursor_usage_limit_exceeded",
      evidence: frame.slice(0, 2_000),
    };
  },
};

const antigravityAdapter: QuotaAdapter = {
  classify() { return UNKNOWN; },
  succeeded(outcome) {
    if (outcome.terminalEnvelope !== undefined) return antigravitySuccessfulResult(outcome.terminalEnvelope);
    try {
      const events = antigravityEvents(outcome.stdout);
      const final = events.at(-1);
      return final?.event === "result" && antigravitySuccessfulResult(final.result);
    } catch { return false; }
  },
};

const openCodeAdapter: QuotaAdapter = {
  classify() { return UNKNOWN; },
  succeeded(outcome) { return parseOpenCodeTranscript(outcome.stdout).kind === "complete"; },
};

// No canonical terminal quota envelope is proven for Muse: usage exhaustion
// stays UNKNOWN until captured protocol evidence supports it. A completed
// terminal still vetoes replay as a failure.
const museAdapter: QuotaAdapter = {
  classify() { return UNKNOWN; },
  succeeded(outcome) {
    if (outcome.terminalEnvelope !== undefined) {
      const event = object(outcome.terminalEnvelope);
      const payload = object(event?.payload);
      return typeof event?.payload_type === "string"
        && event.payload_type.startsWith("run.terminal.")
        && payload?.terminal === "completed";
    }
    return museTerminalCompleted(outcome.stdout, "");
  },
};

const QUOTA_ADAPTERS: Readonly<Record<Provider, QuotaAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
  devin: devinAdapter,
  cursor: cursorAdapter,
  antigravity: antigravityAdapter,
  opencode: openCodeAdapter,
  muse: museAdapter,
};

export class QuotaAdapterNotImplementedError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(
      `no quota adapter implemented for provider ${JSON.stringify(provider)}`
    );
    this.name = "QuotaAdapterNotImplementedError";
    this.provider = provider;
  }
}

function adapterFor(provider: Provider): QuotaAdapter {
  // An adversarial or future provider name ("toString", "__proto__", ...)
  // must not resolve through Object.prototype: require an own registry entry
  // with a callable classifier.
  const adapter: QuotaAdapter | undefined = Object.prototype.hasOwnProperty.call(
    QUOTA_ADAPTERS,
    provider
  )
    ? QUOTA_ADAPTERS[provider]
    : undefined;
  if (
    adapter === undefined ||
    typeof adapter.classify !== "function" ||
    typeof adapter.succeeded !== "function"
  ) {
    throw new QuotaAdapterNotImplementedError(provider);
  }
  return adapter;
}

export function assertQuotaAdapter(provider: Provider): void {
  adapterFor(provider);
}

export function classifyProcessOutcome(
  provider: Provider,
  outcome: ProviderProcessOutcome
): TerminalClassification {
  return adapterFor(provider).classify(outcome);
}

export function hasTerminalSuccess(
  provider: Provider,
  outcome: ProviderProcessOutcome
): boolean {
  return adapterFor(provider).succeeded(outcome);
}

export function classifyTerminalEnvelope(
  provider: Provider,
  envelope: unknown
): TerminalClassification {
  return adapterFor(provider).classify({
    stdout: "",
    stderr: "",
    exitCode: 0,
    terminalEnvelope: envelope,
  });
}

// Only credential/control names are reported. Provider-managed overage and
// account billing limits remain outside this local route guard.
const API_CREDENTIAL_ENV: Readonly<Record<Provider, readonly string[]>> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  grok: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"],
  devin: ["DEVIN_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  antigravity: ["GEMINI_API_KEY"],
  opencode: [],
  muse: ["META_API_KEY"],
};

// Provider-selection and gateway switches: count only when set to a truthy
// value, since these are boolean/endpoint controls rather than secrets. They
// are documented first-party controls that route Claude traffic off the
// subscription surface (Bedrock/Vertex/Foundry selection, custom base URL or
// headers).
const API_ROUTE_ENV: Readonly<Record<Provider, readonly string[]>> = {
  claude: [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
  ],
  codex: [],
  grok: [],
  devin: ["DEVIN_API_URL"],
  cursor: ["CURSOR_API_ENDPOINT"],
  antigravity: ["GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH"],
  opencode: [],
  muse: [],
};

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function apiCredentialTakeover(
  provider: Provider,
  env: NodeJS.ProcessEnv
): string | null {
  for (const name of API_CREDENTIAL_ENV[provider]) {
    if ((env[name]?.trim().length ?? 0) > 0) return name;
  }
  for (const name of API_ROUTE_ENV[provider]) {
    if (truthy(env[name])) return name;
  }
  if (provider === "antigravity") {
    for (const [name, value] of Object.entries(env)) {
      if ((name.startsWith("AGY_GATEWAY_") || name.startsWith("AGY_LLM_GATEWAY_")) && truthy(value)) return name;
    }
  }
  return null;
}

// Grok's login banner and sampling use different credential precedence:
// xai-org/grok-build cli_models.rs @f0e3be11. A banner cannot rule out BYOK.
// Devin/Cursor retain their ordinary account checks with isolated config and
// guarded environment inputs; neither exposes an independent billing verdict.
export interface SubscriptionAuthVerdict {
  readonly compatible: boolean;
  readonly reason: string;
}

function codexAuthVerdict(stdout: string, stderr: string): SubscriptionAuthVerdict {
  const combined = `${stdout}\n${stderr}`.trim();
  if (/api[-\s]?key/i.test(combined)) {
    return { compatible: false, reason: "codex is authenticated with an API key" };
  }
  if (/^logged in using chatgpt\.?$/i.test(combined)) {
    return { compatible: true, reason: "ChatGPT subscription auth" };
  }
  return {
    compatible: false,
    reason: "codex login status did not confirm ChatGPT subscription auth",
  };
}

export function subscriptionAuthEvidence(
  provider: Provider,
  preflightStdout: string,
  preflightStderr: string
): SubscriptionAuthVerdict | null {
  switch (provider) {
    case "codex":
      return codexAuthVerdict(preflightStdout, preflightStderr);
    case "grok":
      return {
        compatible: false,
        reason: "Grok per-model BYOK credentials can override session auth; subscription-only routing cannot be verified",
      };
    case "opencode":
      return { compatible: false, reason: "OpenCode subscription-only routing cannot be verified" };
    case "claude":
    case "devin":
    case "cursor":
    case "antigravity":
    case "muse":
      return null;
  }
}

const RECEIPT_FIELD_LIMIT = 500;
const RECEIPT_EVIDENCE_LIMIT = 4_000;

function boundedText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, RECEIPT_FIELD_LIMIT)
    : null;
}

function terminalEnvelopeDetail(provider: Provider, envelope: unknown): JsonObject | null {
  const event = object(envelope);
  if (event === null) return null;
  switch (provider) {
    case "claude":
    case "cursor":
    case "grok": {
      if (event.type !== "result") return null;
      const detail: JsonObject = {};

      if (typeof event.is_error === "boolean") detail.is_error = event.is_error;
      const result = boundedText(event.result);
      if (result !== null) detail.result = result;
      if (provider === "grok" && Array.isArray(event.errors)) {
        const errors = event.errors
          .map(boundedText)
          .filter((entry) => entry !== null)
          .slice(0, 3);
        if (errors.length > 0) detail.errors = errors;
      }
      return Object.keys(detail).length > 0 ? detail : null;
    }
    case "codex": {
      if (
        event.type !== "turn.completed" &&
        event.type !== "turn.failed" &&
        event.type !== "error"
      ) {
        return null;
      }
      const detail: JsonObject = { type: event.type };
      const message = boundedText(event.type === "turn.failed" ? object(event.error)?.message : event.type === "error" ? event.message : null);
      if (message !== null) detail.message = message;
      return detail;
    }
    case "antigravity": {
      const result = event.event === "result" ? object(event.result) : event;
      if (result === null) return null;
      const detail: JsonObject = {};

      const response = boundedText(result.response);
      if (response !== null) detail.response = response;
      return Object.keys(detail).length > 0 ? detail : null;
    }
    case "opencode": {
      if (event.type !== "error") return null;
      const error = object(event.error);
      const detail: JsonObject = {};

      const message = boundedText(error?.message ?? object(error?.data)?.message);
      if (message === null) return null;
      detail.message = message;
      const type = boundedText(error?.type);
      if (type !== null) detail.type = type;
      return Object.keys(detail).length > 0 ? detail : null;
    }
    case "devin":
      return null;
    case "muse": {
      if (typeof event.payload_type !== "string" || !event.payload_type.startsWith("run.terminal.")) return null;
      const terminal = object(event.payload);
      if (terminal === null) return null;
      const detail: JsonObject = {};
      const status = boundedText(terminal.terminal);
      if (status !== null) detail.status = status;
      const reason = boundedText(terminal.reason);
      if (reason !== null) detail.reason = reason;
      return Object.keys(detail).length > 0 ? detail : null;
    }
  }
}

function isTerminalEvent(provider: Provider, event: JsonObject): boolean {
  switch (provider) {
    case "codex":
      return event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error";
    case "claude":
    case "cursor":
    case "grok":
      return event.type === "result";
    case "antigravity":
      return event.event === "result";
    case "opencode":
      return event.type === "error";
    case "devin":
      return false;
    case "muse":
      return typeof event.payload_type === "string" && event.payload_type.startsWith("run.terminal.");
  }
}

function captureSummary(text: string): string {
  let lines = 0;
  let events = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    lines += 1;
    try {
      if (object(JSON.parse(line.trim())) !== null) events += 1;
    } catch {}
  }
  return `${lines} line(s), ${events} JSON event(s)`;
}

export interface FailureCapture {
  readonly phase: "preflight" | "invocation" | "postprocess";
  readonly stdout: string;
  readonly stderr: string;
  readonly note?: string;
  readonly diagnostic?: string;
  readonly terminalEnvelope?: unknown;
}

export function failureDiagnostic(provider: Provider, capture: FailureCapture): string {
  const sections: string[] = [];
  if (capture.note !== undefined) sections.push(capture.note);
  if (capture.diagnostic !== undefined) sections.push(`diagnostic: ${capture.diagnostic}`);
  if (capture.phase !== "preflight") {
    const envelope = capture.terminalEnvelope ?? (capture.phase === "invocation" ? (() => {
      if (provider === "opencode") {
        const parsed = parseOpenCodeTranscript(capture.stdout);
        return parsed.kind === "error" ? parsed.envelope : null;
      }
      const last = jsonObjects(capture.stdout).at(-1);
      return last !== undefined && isTerminalEvent(provider, last) ? last : null;
    })() : null);
    const terminal = terminalEnvelopeDetail(provider, envelope);
    if (terminal !== null) sections.push(`terminal: ${JSON.stringify(terminal)}`);
  }
  sections.push(
    `stdout: ${captureSummary(capture.stdout)}; stderr: ${captureSummary(capture.stderr)}`
  );
  return sections.join("\n").slice(0, RECEIPT_EVIDENCE_LIMIT);
}

export function launcherDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const code = "code" in error ? error.code : null;
  const knownCodes = ["ENOENT", "EACCES", "EPERM", "EIO", "EEXIST", "ENOSPC", "ENOTDIR", "EISDIR", "EMFILE", "EPIPE"];
  return typeof code === "string" && knownCodes.includes(code) ? `Error (${code})` : "Error";
}
