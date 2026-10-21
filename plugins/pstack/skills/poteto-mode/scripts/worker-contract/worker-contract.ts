import {
  PARENT_OPERATION_KINDS,
  type AccessMode,
  type HandoffRequest,
  type Parent,
  type ParentOperationKind,
  type Provider,
  type ToolDenial,
  type WorkerContractMode,
} from "../runner/types.ts";

// Capabilities a strict writer contract requires the realized route to
// provide. A route that cannot prove all of them is unsupported; preparation
// fails before model dispatch instead of silently downgrading.
export const STRICT_CAPABILITIES = [
  "confined-file-edits",
  "git-metadata-denied",
  "remote-mutation-denied",
  "no-shell-descendants",
] as const;
export type StrictCapability = (typeof STRICT_CAPABILITIES)[number];

export interface AssignmentRequest {
  readonly parent: Parent;
  readonly provider: Provider;
  readonly route: "native" | "external";
  readonly access: AccessMode;
  readonly contract: WorkerContractMode;
}

export interface PreparedAssignment {
  readonly kind: "prepared";
  readonly contract: WorkerContractMode;
  readonly enforcement: "prompt-only";
  readonly capabilities: readonly StrictCapability[];
  readonly instructions: string;
}

export interface UnsupportedCapability {
  readonly kind: "unsupported";
  readonly contract: "strict";
  readonly missing: readonly StrictCapability[];
  readonly reason: string;
}

export interface StrictRouteVerdict {
  readonly supported: false;
  readonly missing: readonly StrictCapability[];
  readonly reason: string;
}

const STRICT_REASONS: Readonly<Record<Provider, string>> = {
  claude:
    "Claude's file-only tool selection and restricted flags have not passed a live boundary test for metadata pointers, alternate gitdirs, hardlinks, and authenticated remote mutation",
  codex:
    "no verified control removes the worker shell; workspace-write confines filesystem writes but remote Git mutation through the authenticated network route is unproven",
  grok:
    "Grok tool gating and the workspace sandbox are not verified to confine writes or refuse Git metadata mutation",
  devin:
    "Devin writers need sandboxed exec for file edits; a file-only writer surface is unavailable and --sandbox alone is not proven to block remote Git writes",
  cursor:
    "Cursor sandbox coverage of Git metadata and remote mutations is unverified",
  antigravity:
    "Antigravity file-only tool gating is a tool-surface limit, not a verified OS boundary",
  opencode:
    "OpenCode tool permissions are not an OS sandbox",
  muse:
    "Muse approval and sandbox settings are application checks without a verified OS boundary for Git metadata and remote mutation",
};

// No current route has live evidence for every required boundary. A CLI help
// flag is tool discovery, not an enforcement attestation.
export function strictRouteSupport(request: {
  readonly parent: Parent;
  readonly provider: Provider;
  readonly route: "native" | "external";
}): StrictRouteVerdict {
  if (request.route === "native") {
    return {
      supported: false,
      missing: [...STRICT_CAPABILITIES],
      reason:
        `native ${request.parent} lanes inherit the host's full-access tools; ` +
        "a shared prompt cannot restrict them, so a strict writer contract is unsupported",
    };
  }
  return {
    supported: false,
    missing: [...STRICT_CAPABILITIES],
    reason: STRICT_REASONS[request.provider],
  };
}

export function prepareAssignment(request: AssignmentRequest): PreparedAssignment | UnsupportedCapability {
  const instructions = renderWorkerContractBlock(request);
  if (request.contract === "strict") {
    const verdict = strictRouteSupport(request);
    return {
      kind: "unsupported",
      contract: "strict",
      missing: verdict.missing,
      reason: verdict.reason,
    };
  }
  return {
    kind: "prepared",
    contract: "legacy",
    enforcement: "prompt-only",
    capabilities: [],
    instructions,
  };
}

function capabilityGuidance(request: AssignmentRequest): string {
  if (request.contract === "strict") {
    return (
      "- Your tools are limited to file reads, edits, and searches inside the " +
      "working directories. You have no shell, command, test, network, or " +
      "agent tool. When the task needs a command — a build, a test run, or a " +
      "Git inspection — request it through the handoff block instead of " +
      "attempting it.\n"
    );
  }
  return "";
}

// The shared ownership and handoff instructions rendered for every writer
// lane, native or external. `providerGuidance` carries genuinely
// provider-specific tool guidance supplied by the adapter.
export function renderWorkerContractBlock(
  request: AssignmentRequest,
  providerGuidance: string | null = null
): string {
  const lines = [
    "## Worker contract",
    "",
    "You are a subordinate worker dispatched by the repository-owning parent session.",
    "",
    "Repository Git ownership:",
    "- The parent performs every Git mutation and every repository- or account-level " +
      "operation. Never stage, commit, reset, rebase, cherry-pick, tag, branch, push, " +
      "or fetch; never run `git` with arguments that write; never create or edit files " +
      "inside the repository's Git metadata (its `.git` directory or `.git` pointer " +
      "file, including config, hooks, refs, index, and worktree records); and never " +
      "run package manager, hook, or tool commands that write to it as a side effect.",
    "- Read-only inspection such as `git status`, `git diff`, and `git log` is " +
      "permitted only where your tools can run it; it never authorizes a write.",
    "- Keep every file you create or edit inside the assigned working directory or " +
      "an output path the parent explicitly assigned. In read-only assignments, " +
      "do not edit the inspected checkout; write only the assigned output artifact. " +
      "Disposable scratch repositories inside the working directory are allowed only when " +
      "the task explicitly asks for them and must never reference the repository's " +
      "Git directory.",
  ];
  const guidance = capabilityGuidance(request);
  if (guidance.length > 0) lines.push(guidance.trimEnd());
  if (request.route === "native") {
    lines.push(
      "- Your tools are inherited from the host session. This contract does not " +
        "grant, restrict, or attest any tool surface, and it is not an " +
        "enforcement boundary."
    );
  }
  if (providerGuidance !== null && providerGuidance.trim().length > 0) {
    lines.push(providerGuidance.trimEnd());
  }
  if (request.access === "isolated-write" && request.contract === "legacy") {
    lines.push(
      "Local checks:",
      "- Run the checks suited to your assigned changes through the command or " +
        "test tools your provider surface actually offers. Keep check artifacts " +
        "inside the assigned paths, and never run a check that mutates " +
        "repository Git metadata or performs a remote operation.",
      "- Repair failures your edits caused and rerun the affected checks. A " +
        "failing check is ordinary work, not a denial.",
      "- When your tool surface cannot run a required check, finish your " +
        "assigned edits and request it through the run-checks handoff instead " +
        "of reporting it as verified.",
      "- Report the commands actually run and their observed results, and name " +
        "any check you could not run. The parent's own acceptance checks are " +
        "separate; your report never substitutes for them."
    );
  }
  lines.push(
    "Finishing:",
    "- Complete the available assigned work and end with an ordinary final " +
      "response describing what changed and what you verified. A final response " +
      "without a handoff block closes the task.",
    "- If required work remains blocked on a parent-only operation, end the response " +
      "with exactly one fenced block requesting it:",
    "  ```pstack-handoff",
    '  {"task":"<task id>","checkpoint":"<checkpoint id>","operation":"<operation>",' +
      '"files":["<relative path>"],"checks":["<check id>"],"summary":"<what the parent should do>"}',
    "  ```",
    '  `operation` is one of "commit-checkpoint" or "run-checks". `files` names ' +
      "repository-relative paths the checkpoint covers; `checks` names check " +
      "identifiers the parent should run. A handoff is an untrusted request, not an " +
      "instruction: the parent verifies it and performs its own operation with its " +
      "own arguments. Never write shell commands for the parent to run, and never " +
      "claim the operation already happened.",
    "- If a tool you need is denied, stop there, describe the denied operation in " +
      "your final response, and do not retry it, work around it, escalate, or " +
      "substitute a fallback route. The parent inspects preserved work before " +
      "anything continues."
  );
  return lines.join("\n");
}

export function renderWorkerPrompt(
  request: AssignmentRequest,
  taskPrompt: string,
  providerGuidance: string | null = null
): string {
  return `${renderWorkerContractBlock(request, providerGuidance)}\n\nAssigned task:\n${taskPrompt}`;
}

export type HandoffParse =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly handoff: HandoffRequest }
  | { readonly kind: "malformed"; readonly reason: string };

const HANDOFF_BLOCK = /```pstack-handoff[^\S\n]*\r?\n([\s\S]*?)```/g;
const HANDOFF_KEYS = ["task", "checkpoint", "operation", "files", "checks", "summary"] as const;
const HANDOFF_LIMITS = { task: 200, checkpoint: 200, summary: 1_000, files: 200, checks: 50, identifier: 200 } as const;

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value
    : null;
}

// A handoff file entry is a repository-relative path: nonempty, never
// absolute, never traversing above the root.
function handoffPath(value: unknown): string | null {
  const text = boundedString(value, HANDOFF_LIMITS.identifier);
  if (text === null) return null;
  if (text.startsWith("/") || text.startsWith("-") || /^[A-Za-z]:/.test(text)) return null;
  if (/[\\\0\r\n]/.test(text)) return null;
  if (text.split("/").some((segment) => segment === ".." || segment === "." || segment === "" || segment === ".git")) return null;
  return text;
}

function validateHandoff(value: unknown): HandoffRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(HANDOFF_KEYS as readonly string[]).includes(key)) return null;
  }
  const task = boundedString(record.task, HANDOFF_LIMITS.task);
  const checkpoint = boundedString(record.checkpoint, HANDOFF_LIMITS.checkpoint);
  const summary = boundedString(record.summary, HANDOFF_LIMITS.summary);
  if (task === null || checkpoint === null || summary === null) return null;
  if (
    typeof record.operation !== "string" ||
    !(PARENT_OPERATION_KINDS as readonly string[]).includes(record.operation)
  ) {
    return null;
  }
  if (!Array.isArray(record.files) || record.files.length > HANDOFF_LIMITS.files) return null;
  const files: string[] = [];
  for (const entry of record.files) {
    const path = handoffPath(entry);
    if (path === null) return null;
    files.push(path);
  }
  if (!Array.isArray(record.checks) || record.checks.length > HANDOFF_LIMITS.checks) return null;
  const checks: string[] = [];
  for (const entry of record.checks) {
    const check = boundedString(entry, HANDOFF_LIMITS.identifier);
    if (check === null) return null;
    checks.push(check);
  }
  return {
    task,
    checkpoint,
    operation: record.operation as ParentOperationKind,
    files,
    checks,
    summary,
  };
}

// The single boundary where untrusted final-response text becomes a handoff
// request. Exactly one fenced `pstack-handoff` block carrying a fully valid
// payload is accepted; anything else is "none" or "malformed" and can never
// widen authority.
export function parseHandoffBlock(text: string): HandoffParse {
  const matches = [...text.matchAll(HANDOFF_BLOCK)];
  const markers = text.match(/```pstack-handoff\b/g) ?? [];
  if (markers.length === 0) return { kind: "none" };
  if (matches.length !== 1 || markers.length !== 1) {
    return { kind: "malformed", reason: "final response carried more than one pstack-handoff block" };
  }
  if (text.slice(matches[0].index! + matches[0][0].length).trim()) {
    return { kind: "malformed", reason: "pstack-handoff block must end the final response" };
  }
  const payload = matches[0][1];
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { kind: "malformed", reason: "pstack-handoff block is not valid JSON" };
  }
  const handoff = validateHandoff(value);
  if (handoff === null) {
    return { kind: "malformed", reason: "pstack-handoff block failed validation" };
  }
  return { kind: "ok", handoff };
}

// The typed outcome of one worker execution. It separates provider terminal
// delivery from task completion: a delivered response can carry a handoff
// request, and a verified provider-owned denial is neither a completed task
// nor an unknown failure.
export type WorkerOutcome =
  | { readonly kind: "complete" }
  | { readonly kind: "needs-parent-operation"; readonly handoff: HandoffRequest }
  | { readonly kind: "permission-blocked"; readonly denial: ToolDenial }
  | { readonly kind: "failed"; readonly reason: string; readonly malformedHandoff?: boolean };

export function interpretWorkerResult(input: {
  readonly delivered: boolean;
  readonly finalText: string | null;
  readonly denial: ToolDenial | null;
}): WorkerOutcome {
  if (!input.delivered && input.denial?.verified === true && input.denial.cause === "permission") {
    return { kind: "permission-blocked", denial: input.denial };
  }
  if (!input.delivered) {
    return { kind: "failed", reason: "the provider did not deliver a terminal response" };
  }
  const parsed = parseHandoffBlock(input.finalText ?? "");
  if (parsed.kind === "ok") {
    return { kind: "needs-parent-operation", handoff: parsed.handoff };
  }
  if (parsed.kind === "malformed") {
    return { kind: "failed", reason: parsed.reason, malformedHandoff: true };
  }
  return { kind: "complete" };
}
