import { createOpenCodeShell, type OpenCodeShell } from "./opencode-shell.ts";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  NO_PROGRESS,
  openReporter,
  type ChildRole,
  type ProgressReporter,
} from "./progress.ts";
import { CLAUDE_WRITER_MINIMUM_VERSION, claudeWriterVersionError, invocationCommand, openCodeAuthListCommand, openCodePreflightCommand, preflightCommand, type CommandSpec } from "./commands.ts";
import { nativeLane } from "./native-route.ts";
import { openCodeAgent, openCodeAttempt, openCodeDirectory, openCodeFilesUnchanged, openCodeFunding, openCodeOAuthPreflightPassed, openCodePreflightPassed, openCodeProbeEnvironment, openCodeSelectVersion, openCodeV1OAuthListPassed, inspectOpenCodeStream, parseOpenCodeExport, OPENCODE_CHATGPT_ENDPOINT, OPENCODE_CHATGPT_SUBSCRIPTION_MODEL, OPENCODE_SUPPORTED_RANGE, OPENCODE_TESTED_VERSIONS, type OpenCodeContract, type OpenCodeTranscript, type OpenCodeVersion, validateOpenCodeModel, type OpenCodeAttempt } from "./opencode.ts";
import { cursorConfigDirectory, cursorConfig, cursorHasApiKey, cursorUserConfigPath, validateCursorModel } from "./cursor.ts";
import { AntigravityPolicyError } from "./antigravity-policy.ts";
import { antigravityLaneFiles, antigravitySettingsPath, antigravitySettingsTakeover, antigravityStdin, antigravityWriterVersion, auditAntigravityStream, createAntigravityLaneFiles, validateAntigravityModel, type AntigravityCreatedFiles } from "./antigravity.ts";
import { versionedClaudeAlias } from "./model-aliases.ts";
import { parseProviderOutput, reportedModelMatches } from "./parse-output.ts";
import {
  ProviderTerminalError,
  ProviderToolDeniedError,
  antigravityHookDenial,
  apiCredentialTakeover,
  assertQuotaAdapter,
  classifyProcessOutcome,
  classifyTerminalEnvelope,
  failureDiagnostic,
  hasTerminalSuccess,
  providerDenialEvidence,
  launcherDiagnostic,
  subscriptionAuthEvidence,
} from "./provider-failure.ts";
import {
  interpretWorkerResult,
  renderWorkerPrompt,
  strictRouteSupport,
} from "../worker-contract/worker-contract.ts";
import type {
  Provider,
  ReceiptStatus,
  RunnerOptions,
  RunnerReceipt,
} from "./types.ts";
import { OutputValidationError, UsageError } from "./types.ts";
import { devinConfig, devinConfigPath, devinExportDirectory, devinExportPath, devinModel, devinPromptPath, readDevinExport } from "./devin.ts";
import { museCompletedWithoutModel, musePreflightPassed } from "./muse.ts";

const ERROR_EVIDENCE_LIMIT = 4_000;
const GROK_PREFLIGHT_RETRY_DELAY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelledBy: CancellationSignal | null;
}

type CancellationSignal = "SIGINT" | "SIGTERM";

interface RunCancellation {
  readonly promise: Promise<CancellationSignal>;
  readonly signal: CancellationSignal | null;
  dispose(): void;
}

type RetryWaitResult = "ready" | "cancelled" | "timed-out";

export interface RunResult {
  readonly exitCode: number;
  readonly receipt: RunnerReceipt;
}

function evidence(value: string): string {
  return value.trim().slice(0, ERROR_EVIDENCE_LIMIT);
}

// The Muse probe emits ~15KB of envelope JSON; its verdict (terminal event,
// usage, stderr reason) is at the end, so classification reads the tail.
function evidenceTail(value: string): string {
  return value.trim().slice(-ERROR_EVIDENCE_LIMIT);
}

function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

// The runner-rendered contract prompt for providers that read the task from a
// file instead of stdin.
function contractPromptPath(options: RunnerOptions): string {
  return `${options.receiptPath}.contract-prompt.md`;
}

function reserve(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
}

function reserveOutputs(options: RunnerOptions): void {
  if (options.outputPath === options.receiptPath) {
    throw new UsageError("output and receipt paths must differ");
  }
  const progressPath = options.progressPath ?? null;
  const reserved: string[] = [];
  try {
    for (const path of [
      options.outputPath,
      options.receiptPath,
      ...(progressPath === null ? [] : [progressPath]),
    ]) {
      reserve(path);
      reserved.push(path);
    }
  } catch (error) {
    for (const path of reserved) removeIfExists(path);
    throw error;
  }
}

function openLaneReporter(options: RunnerOptions, started: number): ProgressReporter {
  if (options.progressPath == null) return NO_PROGRESS;
  try {
    const stat = statSync(options.receiptPath);
    return openReporter(options.progressPath, {
      provider: options.provider,
      startedAt: started,
      receiptRef: { dev: stat.dev, ino: stat.ino },
    });
  } catch {
    return NO_PROGRESS;
  }
}

function writeReceipt(path: string, receipt: RunnerReceipt): void {
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function installRunCancellation(): RunCancellation {
  let signal: CancellationSignal | null = null;
  let resolveCancellation!: (value: CancellationSignal) => void;
  const promise = new Promise<CancellationSignal>((resolve) => {
    resolveCancellation = resolve;
  });

  const receive = (next: CancellationSignal): void => {
    if (signal === null) {
      signal = next;
      resolveCancellation(next);
    }
  };
  const onInterrupt = (): void => receive("SIGINT");
  const onTerminate = (): void => receive("SIGTERM");
  globalThis.process.on("SIGINT", onInterrupt);
  globalThis.process.on("SIGTERM", onTerminate);

  return {
    promise,
    get signal() {
      return signal;
    },
    dispose() {
      globalThis.process.off("SIGINT", onInterrupt);
      globalThis.process.off("SIGTERM", onTerminate);
    },
  };
}

const CODEX_IDENTITY = [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CI",
  "CODEX_SHELL",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
] as const;

const CLAUDE_IDENTITY = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const;

export function childEnvironment(
  provider: Provider,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result = { ...source };
  const remove = provider === "codex"
    ? CLAUDE_IDENTITY
    : [...CODEX_IDENTITY, ...CLAUDE_IDENTITY];
  for (const key of remove) delete result[key];
  if (provider === "devin") delete result.DEVIN_REFUSAL_FALLBACK;
  return result;
}

async function terminate(
  child: Bun.Subprocess,
  signal: CancellationSignal = "SIGTERM"
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  child.kill(signal);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let exited: boolean;
  try {
    exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
  } finally {
    if (graceTimer !== null) clearTimeout(graceTimer);
  }
  if (!exited) {
    child.kill("SIGKILL");
    await child.exited;
  }
  return true;
}

interface StreamCapture {
  readonly result: Promise<string>;
  cancel(): Promise<void>;
}

function captureStream(
  stream: ReadableStream<Uint8Array>,
  onBytes?: (byteLength: number) => void
): StreamCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let cancellationRequested = false;

  const result = (async (): Promise<string> => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        try {
          onBytes?.(next.value.byteLength);
        } catch {
        }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      text += decoder.decode();
      if (!cancellationRequested) throw error;
      return text;
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    result,
    async cancel() {
      cancellationRequested = true;
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed and its reader released.
      }
    },
  };
}

type ProcessEvent =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "cancelled"; readonly signal: CancellationSignal }
  | { readonly kind: "timed-out" };

interface ProcessObserver {
  readonly reporter: ProgressReporter;
  readonly role: ChildRole;
}

async function runProcess(
  executable: string,
  spec: CommandSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  deadlineAt: number | null,
  cancellation: RunCancellation,
  observer?: ProcessObserver
): Promise<ProcessResult> {
  if (observer?.reporter === NO_PROGRESS) observer = undefined;
  const child = Bun.spawn([executable, ...spec.args], {
    cwd: spec.cwd ?? cwd,
    env,
    stdin: spec.stdin === "none" ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let exitRecorded = false;
  const recordExit = (exitCode: number): void => {
    if (exitRecorded || observer === undefined) return;
    exitRecorded = true;
    observer.reporter.record({ t: "exited", role: observer.role, exitCode });
  };
  const recordSettled = (sent: boolean, cause: "cancel" | "deadline"): void => {
    observer?.reporter.record({
      t: "child-settled",
      outcome: sent ? "signalled-and-exited" : "already-exited",
      cause,
    });
  };
  observer?.reporter.record({
    t: "spawned",
    role: observer.role,
    pid: child.pid,
    startToken: null,
  });
  const stdoutCapture = captureStream(child.stdout, (n) =>
    observer?.reporter.record({ t: "bytes", stream: "stdout", n })
  );
  const stderrCapture = captureStream(child.stderr, (n) =>
    observer?.reporter.record({ t: "bytes", stream: "stderr", n })
  );
  const streams = Promise.all([stdoutCapture.result, stderrCapture.result]);
  const exited = child.exited.then((exitCode): ProcessEvent => ({
    kind: "exited",
    exitCode,
  }));
  const cancelled = cancellation.promise.then((signal): ProcessEvent => ({
    kind: "cancelled",
    signal,
  }));
  const deadline: Promise<ProcessEvent> | null = deadlineAt === null
    ? null
    : new Promise((resolve) => {
      const arm = (): void => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          resolve({ kind: "timed-out" });
          return;
        }
        deadlineTimer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      };
      arm();
    });
  try {
    if (spec.stdin !== "none") {
      const stdin = child.stdin;
      if (stdin === undefined) throw new Error("child stdin pipe was not created");
      stdin.write(prompt);
      stdin.end();
    }

    const completions = [exited, cancelled];
    if (deadline !== null) completions.push(deadline);
    const first = await Promise.race(completions);

    let outcome = first;
    let captured: readonly [string, string] | null = null;
    let signalSent: CancellationSignal | null = null;

    if (first.kind === "exited") {
      recordExit(first.exitCode);
      const drains: Array<Promise<
        | { readonly kind: "drained"; readonly captured: readonly [string, string] }
        | ProcessEvent
      >> = [
        streams.then((value) => ({ kind: "drained" as const, captured: value })),
        cancelled,
      ];
      if (deadline !== null) drains.push(deadline);
      const drain = await Promise.race(drains);
      if (drain.kind === "drained") {
        observer?.reporter.record({ t: "drained", role: observer.role });
        captured = drain.captured;
        if (deadlineAt !== null && Date.now() >= deadlineAt) {
          outcome = { kind: "timed-out" };
        }
      } else {
        outcome = drain;
      }
    }

    const cancelledBy = cancellation.signal;
    const timedOut = cancelledBy === null && outcome.kind === "timed-out";
    if (cancelledBy !== null) {
      const sent = await terminate(child, cancelledBy);
      if (sent) signalSent = cancelledBy;
      recordExit(await child.exited);
      recordSettled(sent, "cancel");
    } else if (timedOut) {
      const sent = await terminate(child);
      if (sent) signalSent = "SIGTERM";
      recordExit(await child.exited);
      recordSettled(sent, "deadline");
    }
    if (captured === null) {
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
      captured = await streams;
    }

    return {
      exitCode: await child.exited,
      signal: signalSent,
      stdout: captured[0],
      stderr: captured[1],
      timedOut,
      cancelledBy,
    };
  } catch (error) {
    await terminate(child, cancellation.signal ?? "SIGTERM");
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    await Promise.allSettled([stdoutCapture.result, stderrCapture.result]);
    throw error;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

async function waitForGrokPreflightRetry(
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<RetryWaitResult> {
  if (cancellation.signal !== null) return "cancelled";

  const now = Date.now();
  if (deadlineAt !== null && now >= deadlineAt) return "timed-out";

  const retryAt = now + GROK_PREFLIGHT_RETRY_DELAY_MS;
  const wakeAt = deadlineAt === null ? retryAt : Math.min(retryAt, deadlineAt);
  const timerResult: RetryWaitResult = wakeAt < retryAt ? "timed-out" : "ready";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      cancellation.promise.then((): RetryWaitResult => "cancelled"),
      new Promise<RetryWaitResult>((resolve) => {
        timer = setTimeout(() => resolve(timerResult), wakeAt - now);
      }),
    ]);
    if (cancellation.signal !== null) return "cancelled";
    if (deadlineAt !== null && Date.now() >= deadlineAt) return "timed-out";
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function preflightPassed(provider: Provider, model: string, result: ProcessResult, apiKeyAuth: boolean = false): boolean {
  if (result.exitCode !== 0 || result.timedOut) return false;
  const combined = `${result.stdout}\n${result.stderr}`;
  switch (provider) {
    case "claude":
    case "opencode":
      return false;
    case "cursor": {
      if (apiKeyAuth) return true;
      try {
        const value: unknown = JSON.parse(result.stdout);
        return value !== null && typeof value === "object" &&
          (value as { isAuthenticated?: unknown }).isAuthenticated === true;
      } catch {
        return false;
      }
    }
    case "codex":
      return /logged in/i.test(combined);
    case "devin":
      return /^Logged in\b/im.test(combined);
    case "grok":
      return /logged in/i.test(combined) && combined.includes(model);
    case "antigravity":
      return combined.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[0] === model);
    case "muse":
      return musePreflightPassed(model, result.stdout, result.stderr);
  }
}

function successfulPreflightEvidence(provider: Provider, model: string, apiKeyAuth: boolean = false): string {
  if (apiKeyAuth) return "CURSOR_API_KEY supplied; authentication deferred to model execution";
  if (provider === "antigravity") return `model ${model} listed; authentication deferred to execution`;
  if (provider === "muse") return `authenticated; model ${model} verified in probe usage`;
  return provider === "grok"
    ? `authenticated; model ${model} available`
    : "authenticated";
}

function unavailableStatus(value: string): ReceiptStatus {
  if (/not logged in|unauthenticated|authentication|sign in|login required|missing meta credentials|\b401\b|\bunauthori[sz]ed\b|invalid.{0,12}api.?key|api.?key.{0,20}(invalid|expired)/i.test(value)) {
    return "unauthenticated";
  }
  if (/upgrade to .{0,30}to access this model/i.test(value)) return "unavailable-model";
  if (/model.{0,40}(not found|unknown|unavailable|unsupported|not supported|invalid|does not exist)|invalid.{0,20}model/i.test(value)) {
    return "unavailable-model";
  }
  return "child-failed";
}

// A Devin lane can finish its final answer and still exit nonzero: the CLI's
// stdout/stderr carry no result protocol, so the ATIF export is the only
// completion evidence and must be assessed before its directory is cleaned
// up. The same parser used for exit-0 results validates it, with an empty
// stderr so a tool-confirmation warning cannot mask a finished transcript. A
// missing, invalid, or incomplete export stays ordinary failure evidence.
function devinFinalExportCompleted(options: RunnerOptions): boolean {
  if (options.provider !== "devin") return false;
  try {
    parseProviderOutput("devin", readDevinExport(options), "", options.model);
    return true;
  } catch {
    return false;
  }
}

function preflightFailureStatus(
  provider: Provider,
  model: string,
  value: string
): ReceiptStatus {
  const status = unavailableStatus(value);
  if (status !== "child-failed") return status;
  if (provider === "muse" && museCompletedWithoutModel(model, value)) return "unavailable-model";
  return (provider === "grok" || provider === "antigravity") && !value.includes(model)
    ? "unavailable-model"
    : "unauthenticated";
}

function retriedPreflightEvidence(
  first: string,
  second: string,
  secondPassed: boolean
): string {
  const firstLabel = "attempt 1 failed:\n";
  const secondLabel = `\n\nattempt 2 ${secondPassed ? "passed" : "failed"}:\n`;
  const payloadLimit = ERROR_EVIDENCE_LIMIT - firstLabel.length - secondLabel.length;
  const firstLimit = Math.floor(payloadLimit / 2);
  const secondLimit = payloadLimit - firstLimit;
  return `${firstLabel}${first.slice(0, firstLimit)}${secondLabel}${second.slice(0, secondLimit)}`;
}

function statusExitCode(status: ReceiptStatus): number {
  switch (status) {
    case "complete":
    case "needs-parent-operation":
      return 0;
    case "cancelled":
      return 130;
    case "malformed-output":
      return 65;
    case "unavailable-cli":
    case "unavailable-model":
      return 69;
    case "child-failed":
      return 70;
    case "usage-exhausted":
      return 75;
    case "unauthenticated":
      return 77;
    case "billing-policy-blocked":
      return 78;
    case "unsupported-capability":
      return 79;
    case "timed-out":
      return 124;
  }
}

function modelProof(
  provider: Provider,
  requested: string,
  reported: string | null
): {
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
} {
  // Antigravity init.model echoes the requested CLI override; it is not an
  // independent report of which backend handled the turn.
  if (provider === "antigravity" && reported === requested) {
    return { reportedModel: reported, modelVerified: false, modelEvidence: "pinned-argv" };
  }
  if (reportedModelMatches(provider, requested, reported)) {
    return {
      reportedModel: reported,
      modelVerified: true,
      modelEvidence: "provider-report",
    };
  }
  if ((provider === "codex" || provider === "devin" || provider === "cursor" || provider === "opencode") && reported === null) {
    return {
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
    };
  }
  return {
    reportedModel: reported,
    modelVerified: false,
    modelEvidence: null,
  };
}

function completeReceipt(
  options: RunnerOptions,
  partial: Omit<RunnerReceipt, "schemaVersion" | "parent" | "provider" | "model" | "effort" | "mode" | "cwd" | "promptPath" | "outputPath" | "receiptPath" | "executionId" | "canonicalPaths" | "timeoutMs">,
  openCodeContract: OpenCodeContract | null = null
): RunnerReceipt {
  return {
    schemaVersion: 2,
    parent: options.parent,
    provider: options.provider,
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    cwd: options.cwd,
    promptPath: options.promptPath,
    outputPath: options.outputPath,
    receiptPath: options.receiptPath,
    executionId: options.executionId ?? options.receiptPath,
    canonicalPaths: {
      cwd: options.canonicalCwd ?? realpathSync(options.cwd),
      output: join(realpathSync(dirname(options.outputPath)), basename(options.outputPath)),
      receipt: join(realpathSync(dirname(options.receiptPath)), basename(options.receiptPath)),
    },
    timeoutMs: options.timeoutMs,
    contract: options.contract ?? "legacy",
    ...(openCodeFunding(options)?.kind === "chatgpt-subscription" ? { funding: { kind: "chatgpt-subscription", model: OPENCODE_CHATGPT_SUBSCRIPTION_MODEL, configuredEndpoint: openCodeContract === "v2" ? OPENCODE_CHATGPT_ENDPOINT : null, authentication: partial.preflight.status === "passed" ? "native-openai-oauth" : null } } : {}),
    ...partial,
  };
}

export function validateOptions(options: RunnerOptions): void {
  assertQuotaAdapter(options.provider);
  openCodeFunding(options);
  if (options.provider === "opencode") validateOpenCodeModel(options.model, options.effort);
  if (options.provider === "cursor") validateCursorModel(options.model, options.effort);
  if (options.provider === "antigravity") {
    validateAntigravityModel(options.model, options.effort);
    if (options.apiSpend === null) throw new UsageError("Antigravity requires explicit --api-spend deny or approved");
  }
  const staleAlias = options.provider === "claude"
    ? versionedClaudeAlias(options.model)
    : null;
  if (staleAlias !== null) {
    throw new UsageError(
      `Claude model ${options.model} is a version pin; normalize it to ${staleAlias} before invoking the runner`
    );
  }
  const native = nativeLane(options.parent, options);
  if (native !== null) {
    throw new UsageError(
      `provider ${options.provider} is native to parent ${options.parent} for ${options.model}@${options.effort} via ${native}; use the parent subagent primitive`
    );
  }
  if (options.model.trim().length === 0) throw new UsageError("model must not be empty");
  if (options.provider === "devin") {
    devinModel(options.model, options.effort);
  } else if (options.provider !== "cursor" && options.provider !== "antigravity" && options.provider !== "opencode" && options.effort === "default") {
    throw new UsageError("default effort is supported only for Cursor, Antigravity, OpenCode, or a Devin model UID");
  }
  if (
    options.timeoutMs !== null &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new UsageError("timeout must be greater than zero");
  }
  if (!existsSync(options.promptPath) || !statSync(options.promptPath).isFile()) {
    throw new UsageError(`prompt is not a file: ${options.promptPath}`);
  }
  if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
    throw new UsageError(`cwd is not a directory: ${options.cwd}`);
  }
  if (
    options.promptPath === options.outputPath ||
    options.promptPath === options.receiptPath
  ) {
    throw new UsageError("prompt, output, and receipt paths must be distinct");
  }
  const progressPath = options.progressPath ?? null;
  if (progressPath !== null) {
    if (
      progressPath === options.promptPath ||
      progressPath === options.cwd ||
      progressPath === options.outputPath ||
      progressPath === options.receiptPath
    ) {
      throw new UsageError(
        "progress path must differ from prompt, cwd, output, and receipt"
      );
    }
    if (
      progressPath.startsWith(`${options.outputPath}.`) ||
      progressPath.startsWith(`${options.receiptPath}.`)
    ) {
      throw new UsageError(
        "progress path must not collide with output or receipt sidecars"
      );
    }
  }
}

interface LaneProgress {
  executable: string | null;
  preflight: RunnerReceipt["preflight"];
  argv: readonly string[];
  modelStarted: boolean;
}

async function executeLane(
  options: RunnerOptions,
  cancellation: RunCancellation,
  started: number,
  deadlineAt: number | null,
  invocation: CommandSpec,
  preflight: CommandSpec | null,
  progress: LaneProgress,
  antigravityCreated: AntigravityCreatedFiles | null,
  reporter: ProgressReporter,
  prompt: string,
  resources: { openCodeShell?: OpenCodeShell }
): Promise<RunResult> {
  const startedAt = new Date(started).toISOString();
  const inherited = childEnvironment(options.provider);
  let env = options.provider === "opencode" ? openCodeProbeEnvironment(options, inherited) : inherited;
  let openCode: OpenCodeAttempt | null = null;
  let detected: OpenCodeVersion | null = null;
  let antigravityVersion: string | null = null;
  let activeInvocation: CommandSpec = invocation;
  const laneReceipt = (partial: Parameters<typeof completeReceipt>[1]): RunnerReceipt => completeReceipt(options, partial, openCode?.contract ?? detected?.contract ?? null);
  const apiKeyAuth = options.provider === "cursor" && cursorHasApiKey(env);
  if (options.provider === "cursor") env.CURSOR_CONFIG_DIR = cursorConfigDirectory(options);

  const takeover = options.apiSpend === "deny"
    ? apiCredentialTakeover(options.provider, env) ??
      (options.provider === "antigravity" ? antigravitySettingsTakeover(antigravitySettingsPath()) : null)
    : null;
  const openCodeBillingBlocked = options.provider === "opencode" && openCodeFunding(options) === null;
  if (takeover !== null || openCodeBillingBlocked) {
    const completed = Date.now();
    const receipt = laneReceipt({
      status: "billing-policy-blocked",
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable: null,
      preflight: progress.preflight,
      argv: [activeInvocation.command, ...activeInvocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: openCodeBillingBlocked
          ? "OpenCode requires explicit API-spend approval or an exact --opencode-chatgpt-subscription attempt with --api-spend deny"
          : `subscription-only policy refuses ambient API credential ${takeover}; approve API spend explicitly or unset it`,
        evidence: "",
      },
      failurePhase: "preflight",
      processStarted: false,
      apiSpend: options.apiSpend ?? "legacy",
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(receipt.status), receipt };
  }

  const executable = Bun.which(activeInvocation.command, {
    PATH: env.PATH,
    cwd: options.cwd,
  });
  progress.executable = executable;
  progress.argv = [executable ?? activeInvocation.command, ...activeInvocation.args];

  let preflightState = progress.preflight;
  let receipt: RunnerReceipt;

  const finishWithoutChild = (
    status: "cancelled" | "timed-out",
    phase: string
  ): RunResult => {
    const completed = Date.now();
    const receivedSignal = status === "cancelled" ? cancellation.signal : null;
    const terminalPreflight = preflight !== null && preflightState.status === "not-run"
      ? { ...preflightState, status }
      : preflightState;
    receipt = laneReceipt({
      status,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: terminalPreflight,
      argv: [executable ?? activeInvocation.command, ...activeInvocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: receivedSignal === null
          ? `explicit deadline elapsed ${phase}`
          : `launcher received ${receivedSignal} ${phase}`,
        evidence: "",
      },
      failurePhase: "preflight",
      processStarted: false,
      apiSpend: options.apiSpend ?? "legacy",
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  };

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before authentication preflight");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before authentication preflight");
  }

  if (executable === null) {
    const completed = Date.now();
    receipt = laneReceipt({
      status: "unavailable-cli",
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable: null,
      preflight: preflightState,
      argv: [activeInvocation.command, ...activeInvocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: `${activeInvocation.command} executable not found`,
        evidence: "",
      },
      failurePhase: "preflight",
      processStarted: false,
      apiSpend: options.apiSpend ?? "legacy",
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(receipt.status), receipt };
  }

  if (preflight !== null) {
    const preflightExecutable = executable;
    let activePreflight: CommandSpec = options.provider === "opencode"
      ? { command: "opencode", args: ["--version"], stdin: "none" }
      : options.provider === "antigravity" && options.mode === "isolated-write"
        ? { command: "agy", args: ["--version"], stdin: "none" }
        : preflight;
    progress.preflight = { ...progress.preflight, argv: [preflightExecutable, ...activePreflight.args] };
    let preflightResult = await runProcess(
      preflightExecutable,
      activePreflight,
      options.cwd,
      env,
      "",
      deadlineAt,
      cancellation,
      { reporter, role: "preflight" }
    );
    let versionError: string | null = null;
    if (options.provider === "opencode") {
      versionError = preflightResult.exitCode === 0
        ? null
        : `OpenCode version check failed. Install ${OPENCODE_SUPPORTED_RANGE} and check opencode --version.`;
      if (versionError === null && preflightResult.cancelledBy === null && !preflightResult.timedOut) {
        const selection = openCodeSelectVersion(preflightResult.stdout);
        if (selection.kind === "unsupported") {
          versionError = selection.message;
        } else {
          detected = selection.version;
          if (options.mode === "isolated-write") resources.openCodeShell = createOpenCodeShell(options.cwd);
          openCode = openCodeAttempt(options, inherited, detected, resources.openCodeShell);
          if (openCode === null) {
            versionError = "OpenCode funding could not be resolved for the selected contract";
          } else {
            if (openCode.contract === "v1") {
              writeFileSync(openCode.configPath, JSON.stringify(openCode.config), { flag: "wx", mode: 0o600 });
            } else {
              writeFileSync(join(openCode.configDirectory, "opencode.json"), JSON.stringify(openCode.config), { flag: "wx", mode: 0o600 });
              writeFileSync(join(openCode.configDirectory, "service.json"), JSON.stringify({ disabled: true }), { flag: "wx", mode: 0o600 });
            }
            env = openCode.environment;
            activeInvocation = invocationCommand(options, options.promptPath, openCode.contract);
            progress.argv = [preflightExecutable, ...activeInvocation.args];
            activePreflight = openCodePreflightCommand(openCode.contract);
            progress.preflight = { ...progress.preflight, argv: [preflightExecutable, ...activePreflight.args] };
            preflightResult = await runProcess(preflightExecutable, activePreflight, options.cwd, env, "", deadlineAt, cancellation, { reporter, role: "preflight" });
          }
        }
      }
    } else if (options.provider === "claude") {
      versionError = preflightResult.exitCode === 0
        ? claudeWriterVersionError(preflightResult.stdout)
        : `Claude Code version check failed. Install Claude Code ${CLAUDE_WRITER_MINIMUM_VERSION} or newer and check claude --version.`;
    }
    if (options.provider === "antigravity" && options.mode === "isolated-write") {
      antigravityVersion = preflightResult.exitCode === 0 ? antigravityWriterVersion(preflightResult.stdout) : null;
      if (antigravityVersion === null) {
        versionError = "Antigravity writers require a stable agy 1.x version with the documented sandbox and hook capabilities; check agy --version.";
      } else if (preflightResult.cancelledBy === null && !preflightResult.timedOut) {
        activePreflight = preflight;
        progress.preflight = { ...progress.preflight, argv: [preflightExecutable, ...activePreflight.args] };
        preflightResult = await runProcess(preflightExecutable, activePreflight, options.cwd, env, "", deadlineAt, cancellation, { reporter, role: "preflight" });
      }
    }
    const detectedLabel = detected === null ? "OpenCode" : `OpenCode ${detected.text} (${detected.contract})`;
    const openCodeConfigNote = `${detectedLabel} configuration preflight failed; supported ${OPENCODE_SUPPORTED_RANGE}, tested ${OPENCODE_TESTED_VERSIONS.join(", ")}; configuration output withheld`;
    let rawPreflightEvidence = versionError ?? (options.provider === "opencode"
      ? openCodeConfigNote
      : options.provider === "muse"
        ? evidenceTail(`${preflightResult.stdout}\n${preflightResult.stderr}`)
        : evidence(`${preflightResult.stdout}\n${preflightResult.stderr}`));
    let passed = versionError === null && (options.provider === "opencode"
      ? versionError === null && preflightResult.exitCode === 0 && openCode !== null && openCodePreflightPassed(preflightResult.stdout, openCode)
      : options.provider === "claude"
        ? versionError === null && preflightResult.exitCode === 0
        : preflightPassed(options.provider, options.model, preflightResult, apiKeyAuth));
    if (passed && openCode?.shell) {
      const sandbox = { command: openCode.shell.executable, args: ["-c", "true"], stdin: "none" as const };
      preflightResult = await runProcess(sandbox.command, sandbox, options.cwd, env, "", deadlineAt, cancellation, { reporter, role: "preflight" });
      passed = preflightResult.exitCode === 0 && openCodeFilesUnchanged(openCode);
      if (!passed) versionError = "OpenCode requires a working shell sandbox. Check sandbox-runtime dependencies and OS support. On macOS, the parent launcher must be outside any enclosing Seatbelt sandbox. No unsandboxed execution was attempted.";
    }
    let billingRouteBlocked = false;
    if (passed && openCode?.funding.kind === "chatgpt-subscription" && preflightResult.cancelledBy === null && !preflightResult.timedOut) {
      if (cancellation.signal !== null) return finishWithoutChild("cancelled", "before native OAuth preflight");
      if (deadlineAt !== null && Date.now() >= deadlineAt) return finishWithoutChild("timed-out", "before native OAuth preflight");
      activePreflight = openCodeAuthListCommand(openCode.contract);
      progress.preflight = { ...progress.preflight, argv: [preflightExecutable, ...activePreflight.args] };
      preflightResult = await runProcess(preflightExecutable, activePreflight, options.cwd, env, "", deadlineAt, cancellation, { reporter, role: "preflight" });
      passed = preflightResult.exitCode === 0
        && (openCode.contract === "v1"
          ? openCodeV1OAuthListPassed(preflightResult.stdout, preflightResult.stderr)
          : openCodeOAuthPreflightPassed(preflightResult.stdout))
        && openCodeFilesUnchanged(openCode);
      billingRouteBlocked = !passed;
      rawPreflightEvidence = `${detectedLabel} requires native authentication metadata confirming exactly one OpenAI OAuth credential and unchanged private configuration. Upgrade OpenCode if auth list does not expose credential methods; otherwise check the native authentication list. Authentication output withheld`;
    }
    const renderPreflightDetail = (): string => failureDiagnostic(options.provider, {
      phase: "preflight",
      stdout: preflightResult.stdout,
      stderr: preflightResult.stderr,
      note: versionError ?? (options.provider === "opencode"
        ? billingRouteBlocked ? rawPreflightEvidence : openCodeConfigNote
        : antigravityVersion === null ? undefined : `Antigravity ${antigravityVersion} satisfies stable 1.x; model discovery failed`),
    });
    let preflightEvidence = passed
      ? options.provider === "opencode"
        ? openCode?.funding.kind === "chatgpt-subscription"
          ? `${detectedLabel}: private configuration verified; exactly one visible native OpenAI OAuth credential${openCode.shell ? "; required shell sandbox startup passed" : ""}`
          : `${detectedLabel}: ${openCode?.contract === "v1" ? "effective agent model and tool policy" : "native configuration"} verified; authentication deferred to execution${openCode?.shell ? "; required shell sandbox startup passed" : ""}`
        : options.provider === "claude"
          ? `Claude Code ${preflightResult.stdout.trim()} satisfies the writer minimum; authentication deferred to invocation`
          : `${antigravityVersion === null ? "" : `Antigravity ${antigravityVersion} satisfies stable 1.x; `}${successfulPreflightEvidence(options.provider, options.model, apiKeyAuth)}`
      : renderPreflightDetail();

    if (
      options.provider === "grok" &&
      !passed &&
      preflightResult.cancelledBy === null &&
      !preflightResult.timedOut &&
      preflightFailureStatus(options.provider, options.model, rawPreflightEvidence) ===
        "unauthenticated"
    ) {
      preflightState = {
        argv: [preflightExecutable, ...preflight.args],
        status: "failed",
        evidence: preflightEvidence,
      };
      progress.preflight = preflightState;

      reporter.record({ t: "retry-wait", on: true });
      const retryWait = await waitForGrokPreflightRetry(deadlineAt, cancellation);
      reporter.record({ t: "retry-wait", on: false });
      if (retryWait !== "ready") {
        preflightState = {
          ...preflightState,
          status: retryWait === "cancelled" ? "cancelled" : "timed-out",
        };
        progress.preflight = preflightState;
        return finishWithoutChild(
          retryWait === "cancelled" ? "cancelled" : "timed-out",
          "during authentication preflight retry delay"
        );
      }

      const firstPreflightEvidence = preflightEvidence;
      preflightResult = await runProcess(
        preflightExecutable,
        preflight,
        options.cwd,
        env,
        "",
        deadlineAt,
        cancellation,
        { reporter, role: "preflight" }
      );
      rawPreflightEvidence = evidence(`${preflightResult.stdout}\n${preflightResult.stderr}`);
      passed = preflightPassed(options.provider, options.model, preflightResult, apiKeyAuth);
      preflightEvidence = retriedPreflightEvidence(
        firstPreflightEvidence,
        passed
          ? successfulPreflightEvidence(options.provider, options.model, apiKeyAuth)
          : renderPreflightDetail(),
        passed
      );
    }

    preflightState = {
      argv: [preflightExecutable, ...activePreflight.args],
      status: preflightResult.cancelledBy !== null
        ? "cancelled"
        : preflightResult.timedOut
          ? "timed-out"
          : passed
            ? "passed"
            : "failed",
      evidence: preflightEvidence,
    };
    progress.preflight = preflightState;

    if (preflightState.status !== "passed") {
      const completed = Date.now();
      const preflightFailure = preflightFailureStatus(
        options.provider,
        options.model,
        rawPreflightEvidence
      );
      const status: ReceiptStatus = preflightResult.cancelledBy !== null
        ? "cancelled"
        : preflightResult.timedOut
          ? "timed-out"
          : versionError !== null ? "unavailable-cli" : billingRouteBlocked ? "billing-policy-blocked" : preflightFailure;
      receipt = laneReceipt({
        status,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
        executable,
        preflight: preflightState,
        argv: [executable, ...activeInvocation.args],
        exitCode: preflightResult.exitCode,
        signal: preflightResult.signal,
        reportedModel: null,
        modelVerified: false,
        modelEvidence: null,
        sessionId: null,
        usage: null,
        costUsd: null,
        error: {
          message: preflightResult.cancelledBy !== null
            ? `launcher received ${preflightResult.cancelledBy} during preflight`
            : preflightResult.timedOut
              ? "authentication preflight timed out"
              : versionError ?? (billingRouteBlocked ? "OpenCode subscription funding preflight failed" : "authentication or model preflight failed"),
          evidence: preflightEvidence,
        },
        failurePhase: "preflight",
        processStarted: false,
        apiSpend: options.apiSpend ?? "legacy",
      });
      removeIfExists(options.outputPath);
      writeReceipt(options.receiptPath, receipt);
      return { exitCode: statusExitCode(status), receipt };
    }

    if (options.apiSpend === "deny" && openCode === null) {
      const verdict = subscriptionAuthEvidence(
        options.provider,
        preflightResult.stdout,
        preflightResult.stderr
      );
      if (verdict !== null && !verdict.compatible) {
        const completed = Date.now();
        receipt = laneReceipt({
          status: "billing-policy-blocked",
          startedAt,
          completedAt: new Date(completed).toISOString(),
          elapsedMs: completed - started,
          executable,
          preflight: preflightState,
          argv: [executable, ...activeInvocation.args],
          exitCode: null,
          signal: null,
          reportedModel: null,
          modelVerified: false,
          modelEvidence: null,
          sessionId: null,
          usage: null,
          costUsd: null,
          error: {
            message: `subscription-only policy refused the observed authentication: ${verdict.reason}`,
            evidence: "",
          },
          failurePhase: "preflight",
          processStarted: false,
          apiSpend: "deny",
        });
        removeIfExists(options.outputPath);
        writeReceipt(options.receiptPath, receipt);
        return { exitCode: statusExitCode(receipt.status), receipt };
      }
    }
  }

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before model execution");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before model execution");
  }

  if (openCode !== null && !openCodeFilesUnchanged(openCode)) throw new OutputValidationError("OpenCode private configuration changed before invocation");
  antigravityCreated?.assertUnchanged();
  const invocationStarted = Date.now();
  progress.modelStarted = true;
  const workloadResult = await runProcess(
    executable,
    activeInvocation,
    options.cwd,
    env,
    options.provider === "antigravity" ? antigravityStdin(prompt, options.cwd, options.mode) : prompt,
    deadlineAt,
    cancellation,
    { reporter, role: "workload" }
  );
  let openCodeExport: OpenCodeTranscript | null = null;
  let exportResult: ProcessResult | null = null;
  if (options.provider === "opencode" && openCode?.contract === "v2" && workloadResult.cancelledBy === null && !workloadResult.timedOut && cancellation.signal === null && (deadlineAt === null || Date.now() < deadlineAt)) {
    const stream = inspectOpenCodeStream(workloadResult.stdout);
    if (stream.kind === "identified") {
      try {
        exportResult = await runProcess(executable, { command: "opencode", args: ["session", "export", "--standalone", stream.sessionId], stdin: "none" }, options.cwd, env, "", deadlineAt, cancellation, { reporter, role: "workload" });
        if (exportResult.exitCode === 0 && exportResult.cancelledBy === null && !exportResult.timedOut) {
          openCodeExport = parseOpenCodeExport(exportResult.stdout, stream, { cwd: options.canonicalCwd ?? options.cwd, prompt, agent: openCodeAgent(options), model: options.model, started: invocationStarted });
        }
      } catch {
        openCodeExport = { kind: "incomplete", reason: "OpenCode native session export failed" };
      }
    } else openCodeExport = stream;
  }
  const nativeTerminalSuccess = openCodeExport?.kind === "complete";
  const result: ProcessResult = {
    ...workloadResult,
    cancelledBy: workloadResult.cancelledBy ?? exportResult?.cancelledBy ?? cancellation.signal,
    timedOut: workloadResult.timedOut || exportResult?.timedOut === true || (deadlineAt !== null && Date.now() >= deadlineAt),
  };
  const completed = Date.now();
  const base = {
    startedAt,
    completedAt: new Date(completed).toISOString(),
    elapsedMs: completed - started,
    executable,
    preflight: preflightState,
    argv: [executable, ...activeInvocation.args],
    exitCode: result.exitCode,
    signal: result.signal,
  } as const;

  if (result.cancelledBy !== null || result.timedOut || result.exitCode !== 0) {
    const outcome = classifyProcessOutcome(options.provider, {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
    const failureEvidence = failureDiagnostic(options.provider, {
      phase: "invocation",
      stdout: result.stdout,
      stderr: result.stderr,
      diagnostic: outcome.code ?? undefined,
    });
    const status: ReceiptStatus = result.cancelledBy !== null
      ? "cancelled"
      : result.timedOut
        ? "timed-out"
        : outcome.status ?? "child-failed";
    const terminalSuccess =
      status !== "cancelled" &&
      (nativeTerminalSuccess || devinFinalExportCompleted(options) ||
        hasTerminalSuccess(options.provider, {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }));
    const denial = providerDenialEvidence(options.provider, result.stderr);
    receipt = laneReceipt({
      ...base,
      status,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      toolDenial: denial ?? undefined,
      error: {
        message: result.cancelledBy !== null
          ? result.signal === result.cancelledBy
            ? `launcher received ${result.cancelledBy}; signal was sent to child`
            : `launcher received ${result.cancelledBy} after child exited`
          : result.timedOut
            ? `launcher exceeded the explicit ${options.timeoutMs}ms deadline`
            : `child exited with status ${result.exitCode}`,
        evidence: failureEvidence,
      },
      failurePhase: "invocation",
      processStarted: true,
      apiSpend: options.apiSpend ?? "legacy",
      terminalSuccess: status === "cancelled" ? undefined : terminalSuccess,
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  try {
    if (options.provider === "opencode" && openCode?.contract === "v2" && openCodeExport?.kind === "error") throw new ProviderTerminalError("opencode", "OpenCode reported a failed session", openCodeExport.envelope);
    if (options.provider === "opencode" && openCode?.contract === "v2" && openCodeExport?.kind !== "complete") throw new OutputValidationError(openCodeExport?.kind === "incomplete" ? openCodeExport.reason : "OpenCode native session export did not prove completion");
    if (options.provider === "antigravity") {
      const denial = antigravityHookDenial(result.stdout);
      if (denial !== null) throw new ProviderToolDeniedError("antigravity", denial.evidence, undefined, denial, "child-failed");
    }
    const parsed = options.provider === "opencode" && openCode?.contract === "v2" && openCodeExport?.kind === "complete" ? openCodeExport.output : parseProviderOutput(
      options.provider,
      options.provider === "devin" ? readDevinExport(options) : result.stdout,
      result.stderr,
      options.model
    );
    if (options.provider === "antigravity") {
      auditAntigravityStream(result.stdout, antigravityLaneFiles(options), options.mode, options.model);
      antigravityCreated?.verifySettlement(parsed.sessionId ?? "");
    }
    const proof = modelProof(
      options.provider,
      options.model,
      parsed.reportedModel
    );
    if (!proof.modelVerified && proof.modelEvidence !== "pinned-argv") {
      throw new OutputValidationError(
        `requested model ${options.model} was not reported by ${options.provider}`
      );
    }
    const outcome = interpretWorkerResult({
      delivered: true,
      finalText: parsed.text,
      denial: null,
    });
    if (outcome.kind === "failed") removeIfExists(options.outputPath);
    else writeFileSync(options.outputPath, parsed.text, { encoding: "utf8", mode: 0o600 });
    receipt = laneReceipt({
      ...base,
      status: outcome.kind === "needs-parent-operation"
        ? "needs-parent-operation"
        : outcome.kind === "failed" ? "malformed-output" : "complete",
      ...proof,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      costUsd: parsed.costUsd,
      toolDenial: undefined,
      handoff:
        outcome.kind === "needs-parent-operation" ? outcome.handoff : undefined,
      handoffMalformed:
        outcome.kind === "failed" && outcome.malformedHandoff === true
          ? true
          : undefined,
      error: outcome.kind === "failed"
        ? { message: outcome.reason, evidence: "reserved final-response handoff marker was malformed" }
        : null,
      terminalSuccess: outcome.kind === "failed" ? nativeTerminalSuccess || hasTerminalSuccess(options.provider, result) : undefined,
      failurePhase: outcome.kind === "failed" ? "postprocess" : null,
      processStarted: true,
      apiSpend: options.apiSpend ?? "legacy",
    });
  } catch (error) {
    const message =
      error instanceof ProviderTerminalError ||
      error instanceof OutputValidationError
        ? error.message.slice(0, 500)
        : launcherDiagnostic(error) || "postprocess validation failed";
    removeIfExists(options.outputPath);
    const terminal =
      error instanceof ProviderTerminalError
        ? classifyTerminalEnvelope(options.provider, error.envelope)
        : null;
    const denial =
      error instanceof ProviderToolDeniedError
        ? error.denial
        : providerDenialEvidence(options.provider, result.stderr);
    const status: ReceiptStatus =
      terminal?.status === "usage-exhausted"
        ? "usage-exhausted"
        : error instanceof ProviderToolDeniedError
          ? error.receiptStatus
          : error instanceof ProviderTerminalError
            ? "child-failed"
            : "malformed-output";
    const terminalSuccess =
      nativeTerminalSuccess || devinFinalExportCompleted(options) ||
      hasTerminalSuccess(options.provider, {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        terminalEnvelope:
          error instanceof ProviderTerminalError ? error.envelope : undefined,
      });
    receipt = laneReceipt({
      ...base,
      status,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      toolDenial: denial ?? undefined,
      error: {
        message,
        evidence: failureDiagnostic(options.provider, {
          phase: "postprocess",
          stdout: result.stdout,
          stderr: result.stderr,
          diagnostic: terminal?.code ?? undefined,
          terminalEnvelope:
            error instanceof ProviderTerminalError ? error.envelope : undefined,
        }),
      },
      failurePhase: "postprocess",
      processStarted: true,
      apiSpend: options.apiSpend ?? "legacy",
      terminalSuccess,
    });
  }

  writeReceipt(options.receiptPath, receipt);
  return { exitCode: statusExitCode(receipt.status), receipt };
}

export async function runLane(
  options: RunnerOptions,
  started: number = Date.now()
): Promise<RunResult> {
  validateOptions(options);
  options = { ...options, canonicalCwd: realpathSync(options.cwd) };
  if ((options.contract ?? "legacy") === "strict") {
    const verdict = strictRouteSupport({
      parent: options.parent, provider: options.provider, route: "external",
    });
    reserveOutputs(options);
    const completed = Date.now();
    const receipt = completeReceipt(options, {
      status: "unsupported-capability",
      startedAt: new Date(started).toISOString(),
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable: null,
      preflight: { argv: [], status: "not-run", evidence: "" },
      argv: [], exitCode: null, signal: null,
      reportedModel: null, modelVerified: false, modelEvidence: null,
      sessionId: null, usage: null, costUsd: null,
      error: { message: verdict.reason, evidence: "strict route lacks live boundary evidence" },
      failurePhase: "preflight", processStarted: false,
      apiSpend: options.apiSpend ?? "legacy",
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    const reporter = openLaneReporter(options, started);
    reporter.record({ t: "terminal", receiptWritten: true });
    reporter.close();
    return { exitCode: statusExitCode(receipt.status), receipt };
  }
  const deadlineAt = options.timeoutMs === null ? null : started + options.timeoutMs;
  const effectivePromptPath =
    options.provider === "grok" || options.provider === "muse"
      ? contractPromptPath(options)
      : options.promptPath;
  const invocation = invocationCommand(options, effectivePromptPath);
  const preflight = preflightCommand(options.provider, options.mode, undefined, options.model);
  const progress: LaneProgress = {
    executable: null,
    preflight: {
      argv: preflight === null ? [] : [preflight.command, ...preflight.args],
      status: "not-run",
      evidence: preflight === null ? "authentication deferred to invocation; billing route unverified" : "",
    },
    argv: [invocation.command, ...invocation.args],
    modelStarted: false,
  };
  const cancellation = installRunCancellation();
  let reporter: ProgressReporter = NO_PROGRESS;
  let outcome: RunResult | null = null;
  let createdCursorConfig = false;
  let createdOpenCodeConfig = false;
  const resources: { openCodeShell?: OpenCodeShell } = {};
  let devinConfigCreated = false;
  let devinExportCreated = false;
  let contractPromptCreated = false;
  let antigravityCreated: AntigravityCreatedFiles | null = null;
  try {
    reserveOutputs(options);
    const progressPath = options.progressPath ?? null;
    if (progressPath !== null) {
      reporter = openLaneReporter(options, started);
      if (cancellation.signal !== null) {
        reporter.record({ t: "cancel-requested", signal: cancellation.signal });
      }
      const attached = reporter;
      cancellation.promise.then((signal) => {
        try {
          attached.record({ t: "cancel-requested", signal });
        } catch {
        }
      });
    }
    try {
      const prompt = renderWorkerPrompt(
        {
          parent: options.parent,
          provider: options.provider,
          route: "external",
          access: options.mode,
          contract: options.contract ?? "legacy",
        },
        readFileSync(options.promptPath, "utf8"),
        invocation.workerGuidance
      );
      if (options.provider === "devin") {
        writeFileSync(devinConfigPath(options), JSON.stringify(devinConfig(options)), {
          encoding: "utf8", mode: 0o600, flag: "wx",
        });
        devinConfigCreated = true;
        mkdirSync(devinExportDirectory(options), { mode: 0o700 });
        devinExportCreated = true;
        reserve(devinExportPath(options));
        writeFileSync(devinPromptPath(options), prompt, {
          encoding: "utf8", mode: 0o600, flag: "wx",
        });
      }
      if (options.provider === "grok" || options.provider === "muse") {
        writeFileSync(contractPromptPath(options), prompt, {
          encoding: "utf8", mode: 0o600, flag: "wx",
        });
        contractPromptCreated = true;
      }
      if (options.provider === "opencode" && openCodeFunding(options) !== null) {
        const directory = openCodeDirectory(options);
        mkdirSync(directory, { mode: 0o700 });
        createdOpenCodeConfig = true;
        for (const name of ["config", "home", "xdg", "data", "state", "cache", "tmp"]) mkdirSync(join(directory, name), { mode: 0o700 });
      }
      if (options.provider === "cursor") {
        const directory = cursorConfigDirectory(options);
        mkdirSync(directory, { mode: 0o700 });
        createdCursorConfig = true;
        writeFileSync(`${directory}/cli-config.json`, JSON.stringify(cursorConfig(options.mode, cursorUserConfigPath(process.env, undefined, options.cwd))), { flag: "wx", mode: 0o600 });
      }
      if (options.provider === "antigravity") antigravityCreated = createAntigravityLaneFiles(options);
      outcome = await executeLane(
        options,
        cancellation,
        started,
        deadlineAt,
        invocation,
        preflight,
        progress,
        antigravityCreated,
        reporter,
        prompt,
        resources
      );
      return outcome;
    } catch (error) {
      const completed = Date.now();
      const signal = cancellation.signal;
      const status: ReceiptStatus = signal !== null
        ? "cancelled"
        : deadlineAt !== null && completed >= deadlineAt
          ? "timed-out"
          : "child-failed";
      const terminalPreflight = preflight !== null && progress.preflight.status === "not-run" && status !== "child-failed"
        ? { ...progress.preflight, status }
        : progress.preflight;
      const receipt = completeReceipt(options, {
        status,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
        executable: progress.executable,
        preflight: terminalPreflight,
        argv: progress.argv,
        exitCode: null,
        signal: null,
        reportedModel: null,
        modelVerified: false,
        modelEvidence: null,
        sessionId: null,
        usage: null,
        costUsd: null,
        error: {
          message: status === "cancelled"
            ? `launcher received ${signal} after reserving output paths`
            : status === "timed-out"
              ? "explicit deadline elapsed after reserving output paths"
              : "launcher failed after reserving output paths",
          evidence: error instanceof AntigravityPolicyError
            ? `Antigravity policy source ${error.source}; key ${error.key}`
            : launcherDiagnostic(error),
        },
        failurePhase: progress.modelStarted ? "invocation" : "preflight",
        processStarted: progress.modelStarted,
        apiSpend: options.apiSpend ?? "legacy",
      });
      removeIfExists(options.outputPath);
      writeReceipt(options.receiptPath, receipt);
      outcome = { exitCode: statusExitCode(status), receipt };
      return outcome;
    }
  } finally {
    try {
      if (devinConfigCreated) removeIfExists(devinConfigPath(options));
      if (devinExportCreated) rmSync(devinExportDirectory(options), { recursive: true, force: true });
      if (resources.openCodeShell) rmSync(resources.openCodeShell.directory, { recursive: true, force: true });
      if (createdOpenCodeConfig) rmSync(openCodeDirectory(options), { recursive: true, force: true });
      if (createdCursorConfig) rmSync(cursorConfigDirectory(options), { recursive: true, force: true });
      if (contractPromptCreated) removeIfExists(contractPromptPath(options));
      try {
        antigravityCreated?.cleanup();
      } catch (error) {
        if (outcome === null) throw error;
        const delivered = outcome.receipt.status === "complete" || outcome.receipt.status === "needs-parent-operation";
        const status = delivered ? "malformed-output" : outcome.receipt.status;
        const receipt: RunnerReceipt = {
          ...outcome.receipt,
          status,
          failurePhase: delivered ? "postprocess" : outcome.receipt.failurePhase,
          terminalSuccess: delivered ? true : outcome.receipt.terminalSuccess,
          error: delivered || outcome.receipt.error === null
            ? { message: "Antigravity cleanup could not remove owned lane files", evidence: launcherDiagnostic(error) }
            : { ...outcome.receipt.error, evidence: `${outcome.receipt.error.evidence.slice(0, 500)}\nAntigravity cleanup could not remove owned lane files: ${launcherDiagnostic(error)}`.slice(0, 1000) },
        };
        removeIfExists(options.outputPath);
        writeReceipt(options.receiptPath, receipt);
        outcome = { exitCode: statusExitCode(status), receipt };
        return outcome;
      }
    } finally {
      try {
        reporter.record({ t: "terminal", receiptWritten: outcome !== null });
        reporter.close();
      } finally {
        cancellation.dispose();
      }
    }
  }
}

export function resolvedOptions(options: RunnerOptions): RunnerOptions {
  return {
    ...options,
    promptPath: resolve(options.promptPath),
    cwd: resolve(options.cwd),
    outputPath: resolve(options.outputPath),
    receiptPath: resolve(options.receiptPath),
    progressPath:
      options.progressPath === null || options.progressPath === undefined
        ? null
        : resolve(options.progressPath),
  };
}
