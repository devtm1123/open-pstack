import { describe, expect, it } from "bun:test";
import {
  QuotaAdapterNotImplementedError,
  assertQuotaAdapter,
  apiCredentialTakeover,
  failureDiagnostic,
  launcherDiagnostic,
  classifyProcessOutcome,
  classifyTerminalEnvelope,
  hasTerminalSuccess,
  subscriptionAuthEvidence,
  type ProviderProcessOutcome,
} from "./provider-failure.ts";
import { PROVIDERS, type Provider } from "./types.ts";

// Canonical terminal quota diagnostic emitted by Codex
// (codex-rs/protocol/src/error.rs @9d8de196, UsageLimitReached for a
// Pro/ProLite plan, wrapped in a turn.failed event per
// codex-rs/exec/src/exec_events.rs @f8c6026c). The event carries message only;
// the CLI does not emit a machine code.
const CODEX_QUOTA_MESSAGE =
  "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.";

function outcome(partial: Partial<ProviderProcessOutcome>): ProviderProcessOutcome {
  return { stdout: "", stderr: "", exitCode: 1, ...partial };
}

describe("codex terminal quota classification", () => {
  it("recognizes the canonical Codex quota diagnostic on a failed turn", () => {
    for (const message of [
      CODEX_QUOTA_MESSAGE,
      "Quota exceeded. Check your plan and billing details.",
      "Your workspace is out of credits. Add credits to continue.",
      "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
      `stream disconnected after retries: ${CODEX_QUOTA_MESSAGE}`,
    ]) {
      const stream = JSON.stringify({ type: "turn.failed", error: { message } });
      const result = classifyProcessOutcome("codex", outcome({ stdout: stream }));
      expect(result.status, message).toBe("usage-exhausted");
      expect(result.code).toBe("codex_usage_limit_exceeded");
    }
  });

  it("recognizes a quota diagnostic in an unrecoverable stream error event", () => {
    const stream = JSON.stringify({ type: "error", message: CODEX_QUOTA_MESSAGE });
    expect(classifyProcessOutcome("codex", outcome({ stdout: stream })).status).toBe("usage-exhausted");
  });

  it("lets a final turn.completed win over an earlier failed or error event", () => {
    const completed = JSON.stringify({ type: "turn.completed", usage: {} });
    for (const earlier of [
      JSON.stringify({ type: "turn.failed", error: { message: CODEX_QUOTA_MESSAGE } }),
      JSON.stringify({ type: "error", message: CODEX_QUOTA_MESSAGE }),
    ]) {
      expect(
        classifyProcessOutcome("codex", outcome({ stdout: `${earlier}\n${completed}` })).status
      ).toBeNull();
    }
  });

  it("never lets stderr JSON override or substitute for the stdout protocol stream", () => {
    const failed = JSON.stringify({ type: "turn.failed", error: { message: CODEX_QUOTA_MESSAGE } });
    const completed = JSON.stringify({ type: "turn.completed", usage: {} });
    expect(
      classifyProcessOutcome("codex", outcome({ stdout: completed, stderr: failed })).status
    ).toBeNull();
    expect(
      classifyProcessOutcome("codex", outcome({ stderr: failed })).status
    ).toBeNull();
  });

  it("ignores generated text, nested JSON, and nonterminal events entirely", () => {
    const generated = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({ code: "insufficient_quota" }),
      },
    });
    expect(classifyProcessOutcome("codex", outcome({ stdout: generated })).status).toBeNull();

    const proseQuota = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: CODEX_QUOTA_MESSAGE },
    });
    const done = JSON.stringify({ type: "turn.completed", usage: {} });
    expect(classifyProcessOutcome("codex", outcome({ stdout: `${proseQuota}\n${done}` })).status).toBeNull();

    const itemError = JSON.stringify({
      type: "item.completed",
      item: { type: "error", message: CODEX_QUOTA_MESSAGE },
    });
    expect(classifyProcessOutcome("codex", outcome({ stdout: itemError })).status).toBeNull();
  });

  it("refuses quoted, generic, and non-quota terminal messages", () => {
    for (const message of [
      `"${CODEX_QUOTA_MESSAGE}"`,
      `{"message":"${CODEX_QUOTA_MESSAGE}"}`,
      "rate limit exceeded: 429 Too Many Requests",
      "Selected model is at capacity. Please try a different model.",
      "shared rollout token budget exhausted",
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      "turn aborted. Something went wrong? Hit `/feedback` to report the issue.",
      "insufficient_quota",
      "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
    ]) {
      const stream = JSON.stringify({ type: "turn.failed", error: { message } });
      expect(
        classifyProcessOutcome("codex", outcome({ stdout: stream })).status,
        message
      ).toBeNull();
    }
    expect(
      classifyProcessOutcome("codex", outcome({ stdout: "You exceeded your current quota" })).status
    ).toBeNull();
    expect(
      classifyProcessOutcome("codex", outcome({ stderr: "HTTP 429 too many requests" })).status
    ).toBeNull();
  });

  it("requires the message end or a documented separator after the diagnostic", () => {
    for (const message of [
      "You've hit your usage limitless plan",
      "You hit your spend cap setup by the workspace",
      "Your workspace is out of credits.x please retry",
      "Quota exceeded. Check your plan and billing details.x",
      `prefix: You've hit your usage limitless plan`,
    ]) {
      const stream = JSON.stringify({ type: "turn.failed", error: { message } });
      expect(
        classifyProcessOutcome("codex", outcome({ stdout: stream })).status,
        message
      ).toBeNull();
    }
  });

  it("rejects quota diagnostics hidden behind unproven auth, rate, or model wrappers", () => {
    for (const message of [
      "Authentication required: You've hit your usage limit. Please log in",
      `Rate limited: ${CODEX_QUOTA_MESSAGE}`,
      `Model unavailable: ${CODEX_QUOTA_MESSAGE}`,
      `upstream call failed: ${CODEX_QUOTA_MESSAGE}`,
      `prefix: ${CODEX_QUOTA_MESSAGE}`,
      `stream disconnected after retries: Authentication required: ${CODEX_QUOTA_MESSAGE}`,
      `note: stream disconnected after retries: ${CODEX_QUOTA_MESSAGE}`,
    ]) {
      const stream = JSON.stringify({ type: "turn.failed", error: { message } });
      expect(
        classifyProcessOutcome("codex", outcome({ stdout: stream })).status,
        message
      ).toBeNull();
    }
  });

  it("classifies the same envelope from a zero-exit terminal error result", () => {
    const envelope = { type: "turn.failed", error: { message: CODEX_QUOTA_MESSAGE } };
    const result = classifyTerminalEnvelope("codex", envelope);
    expect(result.status).toBe("usage-exhausted");
    expect(result.code).toBe("codex_usage_limit_exceeded");
    expect(
      classifyTerminalEnvelope("codex", {
        type: "turn.failed",
        error: { message: "aborted" },
      }).status
    ).toBeNull();
  });
});

const GROK_FREE_USAGE_MESSAGE =
  "You\u2019ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build";

describe("grok terminal quota classification", () => {
  it("recognizes the canonical free-usage diagnostic on an error result", () => {
    const result = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [GROK_FREE_USAGE_MESSAGE],
    };
    for (const classification of [
      classifyTerminalEnvelope("grok", result),
      classifyProcessOutcome("grok", outcome({ stdout: JSON.stringify(result) })),
    ]) {
      expect(classification.status).toBe("usage-exhausted");
      expect(classification.code).toBe("grok_free_usage_exhausted");
    }
    const prefixed = JSON.stringify({ type: "assistant", message: { content: [] } });
    expect(
      classifyProcessOutcome("grok", outcome({ stdout: `${prefixed}\n${JSON.stringify(result)}` })).status
    ).toBe("usage-exhausted");
  });

  it("lets a later successful result supersede an earlier quota error", () => {
    const earlier = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [GROK_FREE_USAGE_MESSAGE],
    });
    const success = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
    });
    expect(
      classifyProcessOutcome("grok", outcome({ stdout: `${earlier}\n${success}` })).status
    ).toBeNull();
  });

  it("refuses generated content, quoted, generic, and wrong-position diagnostics", () => {
    const generated = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `The error was: ${GROK_FREE_USAGE_MESSAGE}`,
    });
    expect(classifyProcessOutcome("grok", outcome({ stdout: generated })).status).toBeNull();

    for (const result of [
      { type: "result", subtype: "error_during_execution", is_error: true, errors: [`"${GROK_FREE_USAGE_MESSAGE}"`] },
      { type: "result", subtype: "error_during_execution", is_error: true, errors: [`note: ${GROK_FREE_USAGE_MESSAGE}`] },
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["HTTP 429 too many requests"] },
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["HTTP 403 forbidden"] },
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["insufficient_quota"] },
      { type: "result", subtype: "error_max_turns", is_error: true, errors: [GROK_FREE_USAGE_MESSAGE] },
      { type: "result", subtype: "error_during_execution", is_error: false, errors: [GROK_FREE_USAGE_MESSAGE] },
      { type: "error", subtype: "error_during_execution", is_error: true, errors: [GROK_FREE_USAGE_MESSAGE] },
    ]) {
      expect(
        classifyTerminalEnvelope("grok", result).status,
        JSON.stringify(result)
      ).toBeNull();
      expect(
        classifyProcessOutcome("grok", outcome({ stdout: JSON.stringify(result) })).status,
        JSON.stringify(result)
      ).toBeNull();
    }
    expect(classifyProcessOutcome("grok", outcome({ stdout: GROK_FREE_USAGE_MESSAGE })).status).toBeNull();
  });
});

// Sanitized capture of the real Claude 2.1.281 quota result recorded during
// this change (exit 1): subtype stays "success" while is_error, the
// api_error terminal reason, the 429 status, and the canonical diagnostic
// together prove exhaustion.
const CLAUDE_REAL_QUOTA = {
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 429,
  terminal_reason: "api_error",
  result: "You've hit your session limit \u00b7 resets 4pm (America/New_York)",
};

describe("claude terminal quota classification", () => {
  it("recognizes the captured real quota envelope on stdout and as a terminal envelope", () => {
    const stdout = JSON.stringify(CLAUDE_REAL_QUOTA);
    for (const classification of [
      classifyProcessOutcome("claude", outcome({ stdout })),
      classifyTerminalEnvelope("claude", CLAUDE_REAL_QUOTA),
    ]) {
      expect(classification.status).toBe("usage-exhausted");
      expect(classification.code).toBe("claude_usage_limit_exceeded");
    }
  });

  it("recognizes the other source-proven rejected-limit diagnostics", () => {
    for (const result of [
      "You've hit your weekly limit \u00b7 resets Monday 9am (America/New_York)",
      "You've hit your Opus limit \u00b7 resets Friday",
      "You've hit your Sonnet limit",
      "You've hit your Fable limit",
      "You've hit your usage credit limit",
      "You've hit your usage limit",
      "You've hit your limit",
      "You've hit your team's shared budget \u00b7 ask your admin to raise it at claude.ai/admin-settings/usage",
      "You've hit your monthly spend limit \u00b7 raise it at claude.ai/settings/usage",
      "You've hit your org's monthly spend limit \u00b7 ask your admin to raise it at claude.ai/admin-settings/usage",
      "You've hit your org's monthly usage limit \u00b7 resets next month",
      "You're out of usage credits \u00b7 resets tomorrow",
    ]) {
      const envelope = { ...CLAUDE_REAL_QUOTA, result };
      expect(
        classifyProcessOutcome("claude", outcome({ stdout: JSON.stringify(envelope) })).status,
        result
      ).toBe("usage-exhausted");
    }
  });

  it("requires the full trustworthy errored api_error frame, not subtype or 429 alone", () => {
    for (const envelope of [
      { ...CLAUDE_REAL_QUOTA, is_error: false },
      { ...CLAUDE_REAL_QUOTA, terminal_reason: "overloaded" },
      { ...CLAUDE_REAL_QUOTA, api_error_status: 500 },
      { ...CLAUDE_REAL_QUOTA, api_error_status: 403 },
      { ...CLAUDE_REAL_QUOTA, terminal_reason: undefined, api_error_status: undefined },
      { ...CLAUDE_REAL_QUOTA, result: "Request rejected (429) \u00b7 slow down" },
      { ...CLAUDE_REAL_QUOTA, result: "insufficient_quota" },
      { ...CLAUDE_REAL_QUOTA, result: `"${CLAUDE_REAL_QUOTA.result}"` },
      { ...CLAUDE_REAL_QUOTA, result: `note: ${CLAUDE_REAL_QUOTA.result}` },
      { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "api_error", api_error_status: 429, errors: [CLAUDE_REAL_QUOTA.result] },
      { type: "error", is_error: true, terminal_reason: "api_error", api_error_status: 429, result: CLAUDE_REAL_QUOTA.result },
      { is_error: true, errors: [JSON.stringify({ type: "error", error: { type: "insufficient_quota" } })] },
    ]) {
      expect(
        classifyProcessOutcome("claude", outcome({ stdout: JSON.stringify(envelope) })).status,
        JSON.stringify(envelope)
      ).toBeNull();
      expect(
        classifyTerminalEnvelope("claude", envelope).status,
        JSON.stringify(envelope)
      ).toBeNull();
    }
    expect(
      classifyProcessOutcome("claude", outcome({ stdout: CLAUDE_REAL_QUOTA.result })).status
    ).toBeNull();
    expect(
      classifyProcessOutcome("claude", outcome({ stderr: JSON.stringify(CLAUDE_REAL_QUOTA) })).status
    ).toBeNull();
  });

  it("reads quota proof only from the terminal result in a stream", () => {
    const assistant = JSON.stringify({
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        model: "claude-opus-9",
        content: [{ type: "text", text: CLAUDE_REAL_QUOTA.result }],
      },
    });
    expect(
      classifyProcessOutcome(
        "claude",
        outcome({ stdout: `${assistant}\n${JSON.stringify(CLAUDE_REAL_QUOTA)}` })
      ).status
    ).toBe("usage-exhausted");
    expect(
      classifyProcessOutcome("claude", outcome({ stdout: assistant })).status
    ).toBeNull();
  });

  it("requires the message end or the composer's ` \u00b7 ` separator after the diagnostic", () => {
    for (const result of [
      "You've hit your session limitless requests",
      "You've hit your usage limitless credits",
      "You've hit your weekly limited-time offer",
      "You've hit your limit, sorry",
      "You've hit your Haiku limit",
      "You're out of usage creditsville",
    ]) {
      const envelope = { ...CLAUDE_REAL_QUOTA, result };
      expect(
        classifyProcessOutcome("claude", outcome({ stdout: JSON.stringify(envelope) })).status,
        result
      ).toBeNull();
      expect(classifyTerminalEnvelope("claude", envelope).status, result).toBeNull();
    }
  });

  it("lets a later successful result supersede an earlier quota error", () => {
    const success = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
    });
    expect(
      classifyProcessOutcome(
        "claude",
        outcome({ stdout: `${JSON.stringify(CLAUDE_REAL_QUOTA)}\n${success}` })
      ).status
    ).toBeNull();
  });
});

describe("devin terminal quota classification", () => {
  const monthly =
    "You've reached your monthly usage limit. Wait for the limit to reset next month.";
  const orgMonthly =
    "Your organization has reached its monthly usage limit. Ask an account admin to raise it, or wait for the limit to reset next month.";

  it("recognizes anchored Error: quota lines only on a nonzero exit", () => {
    for (const stderr of [
      `Error: Quota exhausted: ${monthly}`,
      `Error: Quota exhausted: ${orgMonthly}`,
      "Error: Quota exhausted: usage quota has been exhausted",
      `Error: ${monthly}`,
      `Error: ${orgMonthly}`,
      "Error: usage quota has been exhausted",
      `warning: retrying transport\nError: Quota exhausted: ${monthly}`,
      `\u001b[31mError: Quota exhausted: ${monthly}\u001b[0m\r`,
    ]) {
      const result = classifyProcessOutcome("devin", outcome({ stderr }));
      expect(result.status, stderr).toBe("usage-exhausted");
      expect(result.code, stderr).toBe("devin_quota_exhausted");
    }
  });

  it("requires a nonzero exit and refuses rate, auth, admin-pause, model, and prose shapes", () => {
    const monthly =
      "You've reached your monthly usage limit. Wait for the limit to reset next month.";
    for (const value of [
      outcome({ stderr: `Error: Quota exhausted: ${monthly}`, exitCode: 0 }),
      outcome({ stderr: `Error: Quota exhausted: ${monthly}`, exitCode: null }),
      outcome({ stderr: "Error: Rate limited: retry after 30 seconds" }),
      outcome({ stderr: "Error: Authentication required: Sign in again to continue" }),
      outcome({ stderr: "Error: An admin paused usage on your account. Ask them to resume it to continue." }),
      outcome({ stderr: "Error: Unknown model: 'pstack-nonexistent-model'" }),
      outcome({ stderr: "Error: HTTP 429 too many requests" }),
      outcome({ stdout: `final answer: ${monthly}`, stderr: "" }),
      outcome({ stdout: `Error: Quota exhausted: ${monthly}`, stderr: "" }),
      outcome({ stderr: `Quota exhausted: ${monthly}` }),
    ]) {
      expect(
        classifyProcessOutcome("devin", value).status,
        JSON.stringify(value)
      ).toBeNull();
    }
  });
  it("refuses diagnostics nested inside auth, rate, or arbitrary Error: prefixes", () => {
    const monthly =
      "You've reached your monthly usage limit. Wait for the limit to reset next month.";
    for (const stderr of [
      "Error: Authentication required: usage quota has been exhausted",
      `Error: Authentication required: ${monthly}`,
      "Error: Rate limited: Quota exhausted: temporary burst",
      "Error: Rate limited: Quota exhausted: usage quota has been exhausted",
      "Error: upstream call failed: usage quota has been exhausted",
      "Error: Quota exhausted: temporary burst",
      "Error: Quota exhausted: usage quota has been exhausted. retry now",
      "Error: Quota exhausted:",
      "Error: Quota exhausted",
      `Error: ${monthly} (simulated)`,
      `Error: monthly acu limit reached`,
    ]) {
      expect(
        classifyProcessOutcome("devin", outcome({ stderr })).status,
        stderr
      ).toBeNull();
    }
  });

  it("rejects multiple stderr Error: frames as ambiguous", () => {
    const monthly =
      "You've reached your monthly usage limit. Wait for the limit to reset next month.";
    for (const stderr of [
      `Error: Rate limited: retry later\nError: Quota exhausted: ${monthly}`,
      `Error: Quota exhausted: ${monthly}\nError: Authentication required: sign in`,
      `Error: Quota exhausted: ${monthly}\nError: Quota exhausted: ${monthly}`,
    ]) {
      expect(
        classifyProcessOutcome("devin", outcome({ stderr })).status,
        stderr
      ).toBeNull();
    }
  });

  it("lets a trusted successful terminal envelope veto the stderr diagnostic", () => {
    const monthly =
      "You've reached your monthly usage limit. Wait for the limit to reset next month.";
    for (const terminalEnvelope of [
      { type: "result", subtype: "success", is_error: false, result: "done" },
      { type: "result", subtype: "success" },
      { type: "turn.completed", usage: {} },
    ]) {
      expect(
        classifyProcessOutcome(
          "devin",
          outcome({
            stderr: `Error: Quota exhausted: ${monthly}`,
            terminalEnvelope,
          })
        ).status,
        JSON.stringify(terminalEnvelope)
      ).toBeNull();
    }
  });

  it("does not let an unrecognized or errored terminal envelope veto the stderr contract", () => {
    const monthly =
      "You've reached your monthly usage limit. Wait for the limit to reset next month.";
    for (const terminalEnvelope of [
      { type: "result", is_error: true, errors: ["other"] },
      { type: "result", subtype: "success", is_error: true },
      { type: "result", is_error: false },
      { type: "result", subtype: "error_during_execution", is_error: false },
      { unexpected: true },
    ]) {
      expect(
        classifyProcessOutcome(
          "devin",
          outcome({
            stderr: `Error: Quota exhausted: ${monthly}`,
            terminalEnvelope,
          })
        ).status,
        JSON.stringify(terminalEnvelope)
      ).toBe("usage-exhausted");
    }
  });
});


describe("cursor terminal quota classification", () => {
  const cap =
    "ActionRequiredError: You've hit your usage limit for Opus. Upgrade your plan or wait for your limit to reset.";

  it("recognizes the exact error frame plus the documented cap diagnostic on a nonzero exit", () => {
    for (const stderr of [
      cap,
      `warning: reconnecting\n${cap}`,
    ]) {
      const result = classifyProcessOutcome("cursor", outcome({ stderr }));
      expect(result.status, stderr).toBe("usage-exhausted");
      expect(result.code, stderr).toBe("cursor_usage_limit_exceeded");
    }
  });

  it("lets a successful stdout result envelope outrank the stderr diagnostic", () => {
    const success = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
    });
    expect(
      classifyProcessOutcome("cursor", outcome({ stdout: success, stderr: cap })).status
    ).toBeNull();
  });

  it("refuses other ActionRequiredError causes, other error classes, bare diagnostics, and zero exits", () => {
    for (const value of [
      outcome({ stderr: cap, exitCode: 0 }),
      outcome({ stderr: cap, exitCode: null }),
      outcome({ stderr: "ActionRequiredError: Upgrade to Pro to use this model" }),
      outcome({ stderr: "ActionRequiredError: Please log in to continue" }),
      outcome({ stderr: "ActionRequiredError: rate limit exceeded, retry later" }),
      outcome({ stderr: "NonRetriableError: You've hit your usage limit for Opus" }),
      outcome({ stderr: "Error: ActionRequiredError: You've hit your usage limit for Opus" }),
      outcome({ stderr: "You've hit your usage limit for Opus" }),
      outcome({ stdout: cap, stderr: "" }),
      outcome({ stderr: "ActionRequiredError: Agent-store quota exceeded: your write was rejected because the user storage quota is full" }),
    ]) {
      expect(
        classifyProcessOutcome("cursor", value).status,
        JSON.stringify(value)
      ).toBeNull();
    }
  });

  it("rejects contradictory or multiple stderr error frames", () => {
    for (const stderr of [
      `ActionRequiredError: login required\n${cap}`,
      `${cap}\nActionRequiredError: login required`,
      `NonRetriableError: payment failed\n${cap}`,
      `${cap}\n${cap}`,
      `Error: transport broke\n${cap}`,
    ]) {
      expect(
        classifyProcessOutcome("cursor", outcome({ stderr })).status,
        stderr
      ).toBeNull();
    }
  });

  it("normalizes ANSI styling and CRLF endings on the error frame only", () => {
    for (const stderr of [
      `\u001b[31m${cap}\u001b[0m`,
      `${cap}\r\n`,
      `noise\n\u001b[1;31m${cap}\u001b[0m\r`,
    ]) {
      expect(
        classifyProcessOutcome("cursor", outcome({ stderr })).status,
        JSON.stringify(stderr)
      ).toBe("usage-exhausted");
    }
  });

  it("requires the message end or a separator after the usage-limit diagnostic", () => {
    for (const stderr of [
      "ActionRequiredError: You've hit your usage limitless plan",
      "ActionRequiredError: You've hit your usage limited tier",
    ]) {
      expect(
        classifyProcessOutcome("cursor", outcome({ stderr })).status,
        stderr
      ).toBeNull();
    }
  });

  it("lets a trusted successful terminal envelope veto the stderr diagnostic", () => {
    for (const terminalEnvelope of [
      { type: "result", subtype: "success", is_error: false, result: "done" },
      { type: "turn.completed" },
    ]) {
      expect(
        classifyProcessOutcome(
          "cursor",
          outcome({ stderr: cap, terminalEnvelope })
        ).status,
        JSON.stringify(terminalEnvelope)
      ).toBeNull();
    }
  });
});


interface ProviderContract {
  readonly quotaProof?: "none";
  readonly quota: readonly ProviderProcessOutcome[];
  readonly nonquota: readonly ProviderProcessOutcome[];
  readonly terminalSuccess: readonly ProviderProcessOutcome[];
}

const PROVIDER_CONTRACTS: Readonly<Record<Provider, ProviderContract>> = {
  opencode: { quotaProof: "none", quota: [], nonquota: [outcome({ stdout: JSON.stringify({ type: "error", sessionID: "s", error: { name: "APIError", data: { statusCode: 429, message: "quota exhausted" } } }) })], terminalSuccess: [outcome({ stdout: [
    { type: "step_start", sessionID: "s", part: { id: "a", sessionID: "s", messageID: "m" } },
    { type: "text", sessionID: "s", part: { id: "b", sessionID: "s", messageID: "m", text: "done" } },
    { type: "step_finish", sessionID: "s", part: { id: "c", sessionID: "s", messageID: "m", reason: "stop" } },
  ].map(value => JSON.stringify(value)).join("\n") })] },
  claude: {
    quota: [
      outcome({ stdout: JSON.stringify(CLAUDE_REAL_QUOTA) }),
      { stdout: "", stderr: "", exitCode: 0, terminalEnvelope: CLAUDE_REAL_QUOTA },
    ],
    nonquota: [
      outcome({ stdout: JSON.stringify({ ...CLAUDE_REAL_QUOTA, result: "Request rejected (429)" }) }),
      outcome({ stdout: JSON.stringify({ ...CLAUDE_REAL_QUOTA, api_error_status: 500 }) }),
      outcome({ stdout: JSON.stringify({ ...CLAUDE_REAL_QUOTA, result: "You've hit your session limitless" }) }),
    ],
    terminalSuccess: [
      outcome({
        stdout: `${JSON.stringify(CLAUDE_REAL_QUOTA)}\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" })}`,
      }),
      outcome({ stdout: JSON.stringify({ ...CLAUDE_REAL_QUOTA, is_error: false }), exitCode: 0 }),
    ],
  },
  codex: {
    quota: [
      outcome({ stdout: JSON.stringify({ type: "turn.failed", error: { message: CODEX_QUOTA_MESSAGE } }) }),
      outcome({ stdout: JSON.stringify({ type: "error", message: CODEX_QUOTA_MESSAGE }), exitCode: 0 }),
    ],
    nonquota: [
      outcome({ stdout: JSON.stringify({ type: "turn.failed", error: { message: "rate limit exceeded" } }) }),
      outcome({ stdout: JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limitless plan" } }) }),
      outcome({ stderr: CODEX_QUOTA_MESSAGE }),
    ],
    terminalSuccess: [
      outcome({
        stdout: `${JSON.stringify({ type: "turn.failed", error: { message: CODEX_QUOTA_MESSAGE } })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}`,
      }),
    ],
  },
  grok: {
    quota: [
      outcome({
        stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: [GROK_FREE_USAGE_MESSAGE] }),
      }),
    ],
    nonquota: [
      outcome({
        stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["HTTP 429 too many requests"] }),
      }),
    ],
    terminalSuccess: [
      outcome({
        stdout: `${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: [GROK_FREE_USAGE_MESSAGE] })}\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" })}`,
      }),
    ],
  },
  devin: {
    quota: [
      outcome({ stderr: "Error: Quota exhausted: You've reached your monthly usage limit. Wait for the limit to reset next month." }),
      outcome({ stderr: "Error: Your organization has reached its monthly usage limit. Ask an account admin to raise it, or wait for the limit to reset next month." }),
    ],
    nonquota: [
      outcome({ stderr: "Error: Rate limited: retry later" }),
      outcome({ stderr: "Error: Authentication required: Sign in again to continue" }),
      outcome({ stderr: "Error: Authentication required: usage quota has been exhausted" }),
      outcome({ stderr: "Error: Rate limited: Quota exhausted: temporary burst" }),
      outcome({ stderr: "Error: upstream call failed: usage quota has been exhausted" }),
      outcome({ stderr: "Error: Rate limited: retry later\nError: Quota exhausted: usage quota has been exhausted" }),
      outcome({ stderr: "Error: An admin paused usage on your account. Ask them to resume it to continue." }),
    ],
    terminalSuccess: [
      outcome({ stderr: "Error: Quota exhausted: usage quota has been exhausted", exitCode: 0 }),
      outcome({
        stderr: "Error: Quota exhausted: usage quota has been exhausted",
        terminalEnvelope: { type: "result", subtype: "success", is_error: false, result: "done" },
      }),
    ],
  },
  cursor: {
    quota: [
      outcome({ stderr: "ActionRequiredError: You've hit your usage limit for Opus. Upgrade your plan or wait for your limit to reset." }),
    ],
    nonquota: [
      outcome({ stderr: "ActionRequiredError: Upgrade to Pro to use this model" }),
      outcome({ stderr: "ActionRequiredError: Please log in to continue" }),
      outcome({ stderr: "ActionRequiredError: login required\nActionRequiredError: You've hit your usage limit for Opus" }),
      outcome({ stderr: "ActionRequiredError: You've hit your usage limitless plan" }),
    ],
    terminalSuccess: [
      outcome({
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
        stderr: "ActionRequiredError: You've hit your usage limit for Opus",
      }),
      outcome({ stderr: "ActionRequiredError: You've hit your usage limit for Opus", exitCode: 0 }),
      outcome({
        stderr: "ActionRequiredError: You've hit your usage limit for Opus",
        terminalEnvelope: { type: "result", subtype: "success", is_error: false, result: "done" },
      }),
    ],
  },
  antigravity: {
    quotaProof: "none",
    quota: [],
    nonquota: [
      outcome({ stdout: JSON.stringify({ event: "result", result: { status: "ERROR", message: "quota exceeded" } }) }),
      outcome({ stderr: "HTTP 429 RESOURCE_EXHAUSTED" }),
      outcome({ stderr: "MODEL_CAPACITY_EXHAUSTED" }),
    ],
    terminalSuccess: [outcome({ stdout: JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done" } }) })],
  },
  muse: {
    quotaProof: "none",
    quota: [],
    nonquota: [
      outcome({ stderr: "HTTP 429 Too Many Requests: rate limit exceeded" }),
      outcome({
        stdout: JSON.stringify({
          payload_type: "run.terminal.failed",
          payload: { terminal: "failed", text: "", reason: "model `muse-spark-1.3` quota exceeded for today" },
        }),
      }),
    ],
    terminalSuccess: [outcome({
      stdout: JSON.stringify({
        payload_type: "run.terminal.completed",
        payload: { terminal: "completed", text: "done", reason: null },
      }),
    })],
  },
};

describe("terminal success detection", () => {
  it("requires a meaningful provider final success, not a loose is_error:false object", () => {
    for (const provider of PROVIDERS) {
      for (const input of [
        outcome({ stdout: JSON.stringify({ type: "result", is_error: false }) }),
        outcome({ terminalEnvelope: { type: "result", is_error: false } }),
        outcome({ terminalEnvelope: { type: "result", subtype: "error_during_execution", is_error: false } }),
      ]) {
        expect(hasTerminalSuccess(provider, input), `${provider} ${JSON.stringify(input)}`).toBe(false);
      }
    }
    for (const [provider, input] of [
      ["claude", outcome({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) })],
      ["grok", outcome({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) })],
      ["codex", outcome({ stdout: JSON.stringify({ type: "turn.completed", usage: {} }) })],
      ["devin", outcome({ terminalEnvelope: { type: "result", subtype: "success", is_error: false } })],
      ["cursor", outcome({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }) })],
      ["antigravity", outcome({ stdout: JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done" } }) })],
      ["muse", outcome({ stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { terminal: "completed", text: "done", reason: null } }) })],
    ] as const) {
      expect(hasTerminalSuccess(provider, input), provider).toBe(true);
    }
  });
});

describe("provider quota adapter registry", () => {
  for (const provider of PROVIDERS) {
    it(`${provider} implements the quota classification contract`, () => {
      const contract = PROVIDER_CONTRACTS[provider];
      if (contract.quotaProof === "none") expect(contract.quota).toHaveLength(0);
      else expect(contract.quota.length).toBeGreaterThan(0);
      expect(contract.nonquota.length).toBeGreaterThan(0);
      expect(contract.terminalSuccess.length).toBeGreaterThan(0);
      for (const input of contract.quota) {
        expect(
          classifyProcessOutcome(provider, input).status,
          JSON.stringify(input)
        ).toBe("usage-exhausted");
      }
      for (const input of [...contract.nonquota, ...contract.terminalSuccess]) {
        expect(
          classifyProcessOutcome(provider, input).status,
          JSON.stringify(input)
        ).toBeNull();
      }
    });
  }

  it("throws explicitly for a provider with no adapter instead of silently returning unknown", () => {
    const future = "newprovider" as Provider;
    expect(() => classifyProcessOutcome(future, outcome({}))).toThrow(
      QuotaAdapterNotImplementedError
    );
    expect(() => classifyTerminalEnvelope(future, {})).toThrow(
      QuotaAdapterNotImplementedError
    );
  });

  it("throws for prototype keys and other non-own names before routing", () => {
    for (const name of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
      "valueOf",
      "prototype",
    ]) {
      const provider = name as Provider;
      expect(() => assertQuotaAdapter(provider), name).toThrow(
        QuotaAdapterNotImplementedError
      );
      expect(() => classifyProcessOutcome(provider, outcome({})), name).toThrow(
        QuotaAdapterNotImplementedError
      );
      expect(() => classifyTerminalEnvelope(provider, {}), name).toThrow(
        QuotaAdapterNotImplementedError
      );
    }
  });
});

describe("ambient credential and routing takeover guard", () => {
  it("names ambient API credential takeover without exposing values", () => {
    expect(apiCredentialTakeover("cursor", { CURSOR_API_KEY: "secret" })).toBe(
      "CURSOR_API_KEY"
    );
    expect(apiCredentialTakeover("cursor", { CURSOR_API_KEY: "   " })).toBeNull();
    expect(apiCredentialTakeover("claude", { ANTHROPIC_API_KEY: "secret" })).toBe(
      "ANTHROPIC_API_KEY"
    );
    expect(apiCredentialTakeover("codex", { ANTHROPIC_API_KEY: "secret" })).toBeNull();
    expect(apiCredentialTakeover("grok", { XAI_API_KEY: "secret" })).toBe(
      "XAI_API_KEY"
    );
    expect(apiCredentialTakeover("grok", { GROK_CODE_XAI_API_KEY: "secret" })).toBe(
      "GROK_CODE_XAI_API_KEY"
    );
    expect(apiCredentialTakeover("devin", {})).toBeNull();
    expect(apiCredentialTakeover("muse", { META_API_KEY: "secret" })).toBe(
      "META_API_KEY"
    );
    expect(apiCredentialTakeover("muse", { META_API_KEY: "   " })).toBeNull();
    expect(apiCredentialTakeover("muse", { OPENAI_API_KEY: "secret" })).toBeNull();
  });

  it("guards both Antigravity gateway route families without leaking values", () => {
    for (const key of ["AGY_GATEWAY_BASE_URL", "AGY_LLM_GATEWAY_ENDPOINT"]) {
      expect(apiCredentialTakeover("antigravity", {[key]:"secret-route"})).toBe(key);
      expect(apiCredentialTakeover("antigravity", {[key]:"false"})).toBeNull();
    }
  });

  it("covers known Claude alternate-auth and provider-selection controls", () => {
    for (const env of [
      { ANTHROPIC_AUTH_TOKEN: "token" },
      { ANTHROPIC_AWS_API_KEY: "key" },
      { CLAUDE_CODE_USE_BEDROCK: "1" },
      { CLAUDE_CODE_USE_VERTEX: "true" },
      { CLAUDE_CODE_USE_FOUNDRY: "yes" },
      { ANTHROPIC_BASE_URL: "https://gateway.example" },
      { ANTHROPIC_CUSTOM_HEADERS: "x: y" },
    ]) {
      expect(apiCredentialTakeover("claude", env), JSON.stringify(env)).not.toBeNull();
    }
    for (const env of [
      { CLAUDE_CODE_USE_BEDROCK: "0" },
      { CLAUDE_CODE_USE_VERTEX: "false" },
      { CLAUDE_CODE_USE_FOUNDRY: "  " },
      { ANTHROPIC_BASE_URL: "" },
    ]) {
      expect(apiCredentialTakeover("claude", env), JSON.stringify(env)).toBeNull();
    }
    expect(
      apiCredentialTakeover("codex", { CLAUDE_CODE_USE_BEDROCK: "1" })
    ).toBeNull();
  });
});

describe("subscription auth evidence", () => {
  it("distinguishes ChatGPT auth from API-key auth for codex", () => {
    expect(
      subscriptionAuthEvidence("codex", "Logged in using ChatGPT", "")
    ).toMatchObject({ compatible: true });
    for (const stdout of [
      "Logged in using an API key",
      "Logged in",
      "Logged in using ChatGPT but see https://example.com",
      "Logged in using ChatGPT\nextra diagnostic line",
      "mention of chatgpt is not a status line",
      "Logged in using ChatGPT\nwarning: api key fallback configured",
    ]) {
      expect(
        subscriptionAuthEvidence("codex", stdout, "")?.compatible,
        stdout
      ).toBe(false);
    }
    expect(
      subscriptionAuthEvidence("codex", "", "Logged in using an API key")?.compatible
    ).toBe(false);
  });

  it("reports no separate auth-method evidence for Claude, Devin, Cursor, Antigravity, and Muse", () => {
    for (const provider of ["claude", "devin", "cursor", "antigravity", "muse"] as const) {
      expect(subscriptionAuthEvidence(provider, "Logged in", "")).toBeNull();
    }
  });
});

it("blocks Grok subscription-only routing despite a logged-in banner", () => {
  expect(subscriptionAuthEvidence("grok", "Logged in as subscriber\ngrok-4.7", ""))
    .toMatchObject({ compatible: false });
});

it("blocks custom Devin and Cursor endpoints without exposing their values", () => {
  expect(apiCredentialTakeover("devin", { DEVIN_API_URL: "https://alternate.invalid" })).toBe("DEVIN_API_URL");
  expect(apiCredentialTakeover("cursor", { CURSOR_API_ENDPOINT: "alternate.invalid" })).toBe("CURSOR_API_ENDPOINT");
});


describe("receipt diagnostic selection", () => {
  it("retains the OpenCode parser-selected error, not a later frame", () => {
    const stdout = [
      { type: "error", sessionID: "s", error: { message: "selected failure" } },
      { type: "reasoning", sessionID: "s" },
      { type: "error", sessionID: "s", error: { message: "PRIVATE_LATER_FRAME" } },
    ].map((event) => JSON.stringify(event)).join("\n");
    const evidence = failureDiagnostic("opencode", { phase: "invocation", stdout, stderr: "" });
    expect(evidence).toContain("selected failure");
    expect(evidence).not.toContain("PRIVATE_LATER_FRAME");
  });

  it("does not retain result text followed by more activity", () => {
    for (const provider of ["claude", "grok", "antigravity"] as const) {
      const stdout = [
        { type: "result", event: "result", result: provider === "antigravity" ? { response: "PRIVATE" } : "PRIVATE" },
        { type: "assistant", event: "step_update", text: "PRIVATE" },
      ].map((event) => JSON.stringify(event)).join("\n");
      for (const phase of ["invocation", "postprocess"] as const) {
        expect(failureDiagnostic(provider, { phase, stdout, stderr: "" })).not.toContain("PRIVATE");
      }
    }
  });

  it("omits arbitrary metadata and completed-turn extension messages", () => {
    for (const [provider, terminalEnvelope] of [
      ["claude", { type: "result", subtype: "PRIVATE", is_error: true }],
      ["antigravity", { status: "PRIVATE" }],
      ["opencode", { type: "error", error: { name: "PRIVATE" } }],
      ["codex", { type: "turn.completed", message: "PRIVATE", error: { message: "PRIVATE" } }],
    ] as const) {
      expect(failureDiagnostic(provider, { phase: "postprocess", stdout: "", stderr: "", terminalEnvelope })).not.toContain("PRIVATE");
    }
    expect(launcherDiagnostic(Object.assign(new Error("PRIVATE"), { name: "PRIVATE", code: "PRIVATE" }))).toBe("Error");
  });
});
