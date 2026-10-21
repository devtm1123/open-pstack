export const PARENTS = ["claude", "codex"] as const;
export const PROVIDERS = ["claude", "codex", "grok", "devin", "cursor", "antigravity", "opencode", "muse"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ACCESS_MODES = ["read-only", "isolated-write"] as const;
export const WORKER_CONTRACT_MODES = ["legacy", "strict"] as const;

export type Parent = (typeof PARENTS)[number];
export type Provider = (typeof PROVIDERS)[number];
export type Effort = (typeof EFFORTS)[number] | "default";
export type AccessMode = (typeof ACCESS_MODES)[number];
export type WorkerContractMode = (typeof WORKER_CONTRACT_MODES)[number];

export interface RunnerOptions {
  readonly parent: Parent;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: AccessMode;
  readonly promptPath: string;
  readonly cwd: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly executionId?: string;
  readonly canonicalCwd?: string;
  readonly progressPath?: string | null;
  readonly timeoutMs: number | null;
  readonly apiSpend: ApiSpendMode | null;
  readonly opencodeChatgptSubscription?: boolean;
  // The worker contract requested for the lane. Absent means the legacy
  // contract: ownership and handoff instructions without extra enforcement.
  readonly contract?: WorkerContractMode;
}

export const RECEIPT_STATUSES = [
  "complete",
  "needs-parent-operation",
  "cancelled",
  "unavailable-cli",
  "unauthenticated",
  "unavailable-model",
  "usage-exhausted",
  "billing-policy-blocked",
  "timed-out",
  "child-failed",
  "malformed-output",
  "unsupported-capability",
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export type FailurePhase = "preflight" | "invocation" | "postprocess";

export const API_SPEND_MODES = ["deny", "approved"] as const;
export type ApiSpendMode = (typeof API_SPEND_MODES)[number];
export type ReceiptApiSpend = ApiSpendMode | "legacy";

// Parent operation kinds a worker may name in a final-response handoff.
// They are a closed vocabulary of untrusted requests, never shell text, and
// a request never authorizes the operation by itself.
export const PARENT_OPERATION_KINDS = ["commit-checkpoint", "run-checks"] as const;
export type ParentOperationKind = (typeof PARENT_OPERATION_KINDS)[number];

// A validated worker handoff delivered inside a final response. It carries
// structured identifiers only; the parent verifies it against the assigned
// task and performs its own operation with its own arguments.
export interface HandoffRequest {
  readonly task: string;
  readonly checkpoint: string;
  readonly operation: ParentOperationKind;
  readonly files: readonly string[];
  readonly checks: readonly string[];
  readonly summary: string;
}

// A tool denial the provider's own protocol recorded. `verified` is true
// only when the provider emitted the rejection itself; worker prose never
// produces it. Fields the protocol did not report stay null and are never
// filled from untrusted text.
export interface ToolDenial {
  readonly verified: boolean;
  readonly cause?: "permission" | "unknown";
  readonly tool: string | null;
  readonly requestedAction: string | null;
  readonly evidence: string;
}

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}

export interface ParsedOutput {
  readonly text: string;
  readonly reportedModel: string | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
}

export interface RunnerReceipt {
  readonly schemaVersion: 2;
  readonly status: ReceiptStatus;
  readonly parent: Parent;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: AccessMode;
  readonly cwd: string;
  readonly promptPath: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly executionId: string;
  readonly canonicalPaths: {
    readonly cwd: string;
    readonly output: string;
    readonly receipt: string;
  };
  readonly startedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly executable: string | null;
  readonly preflight: {
    readonly argv: readonly string[];
    readonly status: "passed" | "failed" | "timed-out" | "cancelled" | "not-run";
    readonly evidence: string;
  };
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
  readonly error: {
    readonly message: string;
    readonly evidence: string;
  } | null;
  readonly failurePhase: FailurePhase | null;
  readonly processStarted: boolean;
  readonly apiSpend: ReceiptApiSpend;
  readonly funding?: { readonly kind: "chatgpt-subscription"; readonly model: "openai/gpt-6.1-sol"; readonly configuredEndpoint: "https://chatgpt.com/backend-api/codex" | null; readonly authentication: "native-openai-oauth" | null };
  // The worker contract the lane ran under; absent on receipts written
  // before contracts existed and treated as "legacy".
  readonly contract?: WorkerContractMode;
  // Provider-owned denial evidence recorded when the run ended on a refused
  // tool call. Never synthesized from worker prose.
  readonly toolDenial?: ToolDenial;
  // The validated handoff request a needs-parent-operation run delivered, or
  // `handoffMalformed: true` when a handoff block was present but invalid.
  readonly handoff?: HandoffRequest;
  readonly handoffMalformed?: boolean;
  // The explicit launcher deadline when one was supplied, or null. Absent on
  // receipts written before this field existed.
  readonly timeoutMs?: number | null;
  // True when a trusted terminal success shape was observed alongside the
  // failure (for example a final successful result with a nonzero exit). The
  // conflict is preserved here so a retry is never authorized on top of it.
  readonly terminalSuccess?: boolean;
}

export class UsageError extends Error {}

export class OutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputValidationError";
  }
}
