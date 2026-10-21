import { describe, expect, it } from "bun:test";
import {
  museCompletedWithoutModel,
  musePreflightPassed,
  museTerminalCompleted,
  parseMuseEvents,
} from "./muse.ts";

const MODEL = "muse-spark-1.3";

const event = (payload_type: string, payload: unknown) =>
  JSON.stringify({ stream: { kind: "session", id: "muse-session" }, payload_type, payload });

const usage = (models: readonly unknown[]) => event("run.usage", { models });
const terminal = (status: string, text: string | null, reason: string | null = null) =>
  event(`run.terminal.${status}`, { terminal: status, text, reason });
const usageEntry = (model: string) => ({
  model,
  input_tokens: 27370,
  cached_tokens: 0,
  output_tokens: 17,
  reasoning_tokens: 5,
  calls: 1,
});

const verifiedProbe = [
  usage([usageEntry(MODEL)]),
  terminal("completed", "OK"),
].join("\n");

describe("parseMuseEvents", () => {
  it("reads the terminal text with the usage model as proof", () => {
    expect(parseMuseEvents(verifiedProbe, MODEL)).toEqual({
      terminal: { status: "completed", text: "OK", reason: null },
      usageModel: MODEL,
      usage: { inputTokens: 27370, cachedInputTokens: 0, outputTokens: 17, reasoningTokens: 5 },
      sessionId: "muse-session",
    });
  });

  it("keeps a mismatched usage model instead of substituting the request", () => {
    const events = parseMuseEvents(
      [usage([usageEntry("muse-wonder-1.0")]), terminal("completed", "OK")].join("\n"),
      MODEL
    );
    expect(events?.usageModel).toBe("muse-wonder-1.0");
  });

  it("rejects a stream with a non-JSON line", () => {
    expect(parseMuseEvents(`${verifiedProbe}\nnot-json`, MODEL)).toBeNull();
  });
});

describe("musePreflightPassed", () => {
  it("passes only when the probe usage names the requested model", () => {
    expect(musePreflightPassed(MODEL, verifiedProbe, "")).toBe(true);
    expect(musePreflightPassed(
      MODEL,
      [usage([]), terminal("completed", "Hi — how can I help?")].join("\n"),
      ""
    )).toBe(false);
    expect(musePreflightPassed(
      MODEL,
      [usage([usageEntry("muse-wonder-1.0")]), terminal("completed", "OK")].join("\n"),
      ""
    )).toBe(false);
  });

  it("fails on missing credentials, malformed output, and missing terminals", () => {
    expect(musePreflightPassed(MODEL, "", "missing meta credentials: run `muse login`")).toBe(false);
    expect(musePreflightPassed(MODEL, "not-json", "")).toBe(false);
    expect(musePreflightPassed(MODEL, usage([usageEntry(MODEL)]), "")).toBe(false);
    expect(musePreflightPassed(
      MODEL,
      [usage([usageEntry(MODEL)]), terminal("failed", "", "model `x` does not exist")].join("\n"),
      ""
    )).toBe(false);
  });
});

describe("museCompletedWithoutModel", () => {
  it("detects the silent unknown-model fallback inside combined captures", () => {
    expect(museCompletedWithoutModel(
      MODEL,
      [usage([]), terminal("completed", "Hi — how can I help?"), "muse: workspace root: /tmp"].join("\n")
    )).toBe(true);
    expect(museCompletedWithoutModel(
      MODEL,
      [usage([usageEntry("muse-wonder-1.0")]), terminal("completed", "OK")].join("\n")
    )).toBe(true);
  });

  it("stays false for verified, failed, and incomplete probes", () => {
    expect(museCompletedWithoutModel(MODEL, verifiedProbe)).toBe(false);
    expect(museCompletedWithoutModel(
      MODEL,
      [usage([]), terminal("failed", "", "model `x` does not exist")].join("\n")
    )).toBe(false);
    expect(museCompletedWithoutModel(MODEL, usage([usageEntry(MODEL)]))).toBe(false);
  });
});

describe("museTerminalCompleted", () => {
  it("requires a completed terminal status", () => {
    expect(museTerminalCompleted(verifiedProbe, MODEL)).toBe(true);
    expect(museTerminalCompleted(terminal("failed", "", "reason"), MODEL)).toBe(false);
    expect(museTerminalCompleted("", MODEL)).toBe(false);
  });
});
