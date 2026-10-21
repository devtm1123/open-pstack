import { openCodeAgent, type OpenCodeContract } from "./opencode.ts";
import { cursorHasApiKey } from "./cursor.ts";
import { antigravityLaneFiles } from "./antigravity.ts";
import { MUSE_PREFLIGHT_PROMPT } from "./muse.ts";
import type {
  AccessMode,
  Effort,
  Provider,
  RunnerOptions,
} from "./types.ts";

import { devinConfigPath, devinExportPath, devinModel, devinPromptPath } from "./devin.ts";
import { strictRouteSupport } from "../worker-contract/worker-contract.ts";
import { UsageError } from "./types.ts";

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: "prompt" | "prompt-ndjson" | "none";
  readonly cwd?: string;
}

export interface WorkerCommandSpec extends CommandSpec {
  readonly workerGuidance: string;
}

export const CLAUDE_WRITER_MINIMUM_VERSION = "2.1.285";

export const CLAUDE_WRITER_SETTINGS =
  '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true,"excludedCommands":[],"filesystem":{"disabled":false},"network":{"allowedDomains":[]}}}';

export function claudeWriterVersionError(stdout: string): string | null {
  const version = stdout.trim();
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?: \(Claude Code\))?$/.exec(version);
  const parts = match?.slice(1).map(Number);
  if (parts === undefined || !parts.every(Number.isSafeInteger)) {
    return `Cannot verify the Claude Code version. Install Claude Code ${CLAUDE_WRITER_MINIMUM_VERSION} or newer and check claude --version.`;
  }
  const minimum = CLAUDE_WRITER_MINIMUM_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (parts[index] > minimum[index]) return null;
    if (parts[index] < minimum[index]) {
      return `Claude Code ${version} is too old. Writer lanes require ${CLAUDE_WRITER_MINIMUM_VERSION} or newer for the verified sandbox profile.`;
    }
  }
  return null;
}

export function openCodePreflightCommand(contract: OpenCodeContract): CommandSpec {
  return contract === "v1"
    ? { command: "opencode", args: ["--pure", "debug", "config"], stdin: "none" }
    : { command: "opencode", args: ["debug", "config"], stdin: "none" };
}

export function openCodeAuthListCommand(contract: OpenCodeContract): CommandSpec {
  return contract === "v1"
    ? { command: "opencode", args: ["--pure", "auth", "list"], stdin: "none" }
    : { command: "opencode", args: ["auth", "list", "--standalone", "--format", "json"], stdin: "none" };
}

export function openCodeInvocationCommand(options: RunnerOptions, contract: OpenCodeContract): WorkerCommandSpec {
  const guidance = workerGuidance(options.provider, options.mode);
  return contract === "v1"
    ? { command: "opencode", args: ["run", "--pure", "--format", "json", "--model", options.model, "--agent", openCodeAgent(options), "--dir", options.cwd, "--title", "pstack-worker"], stdin: "prompt", workerGuidance: guidance }
    : { command: "opencode", args: ["run", "--standalone", "--format", "json", "--model", options.model, "--agent", openCodeAgent(options), "--title", "pstack-worker"], stdin: "prompt", workerGuidance: guidance };
}

export function openCodeVersionProbe(mode: AccessMode): WorkerCommandSpec {
  return { command: "opencode", args: ["--version"], stdin: "none", workerGuidance: workerGuidance("opencode", mode) };
}

export function preflightCommand(provider: Provider, mode: AccessMode, openCodeContract?: OpenCodeContract, model?: string): CommandSpec | null {
  switch (provider) {
    case "opencode":
      return openCodeContract === undefined
        ? { command: "opencode", args: ["--version"], stdin: "none" }
        : openCodePreflightCommand(openCodeContract);
    case "devin":
      return { command: "devin", args: ["auth", "status"], stdin: "none" };
    case "cursor":
      return {
        command: "cursor-agent",
        args: cursorHasApiKey() ? ["--version"] : ["status", "--format", "json"],
        stdin: "none",
      };
    case "claude":
      return mode === "isolated-write"
        ? { command: "claude", args: ["--version"], stdin: "none" }
        : null;
    case "codex":
      return {
        command: "codex",
        args: ["login", "status"],
        stdin: "none",
      };
    case "grok":
      return { command: "grok", args: ["models"], stdin: "none" };
    case "antigravity":
      return { command: "agy", args: ["models"], stdin: "none" };
    case "muse": {
      // The CLI has no login-status or model-list command, so the preflight
      // is one tiny model call that must verify the requested model.
      if (model === undefined) throw new UsageError("muse preflight requires the requested model");
      return {
        command: "muse",
        args: [
          "exec",
          "--json",
          "--provider",
          "meta",
          "--model",
          model,
          "--reasoning-effort",
          "minimal",
          "--disable-write",
          "--disable-shell",
          "--disable-web-tools",
          "--disable-reminders",
          "--disable-request-user-input",
          "--no-foreign-personal-context",
          "--no-session-log",
          MUSE_PREFLIGHT_PROMPT,
        ],
        stdin: "none",
      };
    }
  }
}

function claudeDeniedTools(mode: AccessMode): string {
  const always = ["Agent", "Task", "WebSearch", "WebFetch"];
  const readonly = ["Edit", "Write", "NotebookEdit"];
  return [...always, ...(mode === "read-only" ? readonly : [])].join(",");
}

function claudeTools(mode: AccessMode): string {
  return mode === "read-only"
    ? "Read,Grep,Glob,Bash"
    : "Read,Write,Edit,Grep,Glob,Bash";
}

function codexSandbox(mode: AccessMode): string {
  return mode === "read-only" ? "read-only" : "workspace-write";
}

function grokSandbox(mode: AccessMode): string {
  return mode === "read-only" ? "read-only" : "workspace";
}

function grokTools(mode: AccessMode): string {
  const readonly = ["read_file", "grep", "list_dir", "run_terminal_cmd"];
  return [...readonly, ...(mode === "isolated-write" ? ["search_replace"] : [])].join(",");
}

function permissionMode(mode: AccessMode): string {
  return mode === "read-only" ? "plan" : "acceptEdits";
}

function effortOverride(effort: Effort): string {
  return `model_reasoning_effort=${JSON.stringify(effort)}`;
}

function workerGuidance(provider: Provider, mode: AccessMode): string {
  if (mode === "read-only") {
    switch (provider) {
      case "claude":
        return "- Provider tools: inspect with `Read`, `Grep`, `Glob`, and `Bash`. Write tools are denied on this lane.";
      case "codex":
        return "- Provider tools: inspect with the CLI's tools inside its `read-only` sandbox.";
      case "grok":
        return "- Provider tools: `read_file`, `grep`, `list_dir`, and `run_terminal_cmd` are available; `search_replace` is denied.";
      case "devin":
        return "- Provider tools: inspect with your read tools. `exec` is disabled on this lane, so command execution is unavailable.";
      case "cursor":
        return "- Provider tools: inspect with the available read tools in ask mode. Writes and shell commands are denied on this lane.";
      case "antigravity":
        return "- Provider tools: `view_file`, `list_dir`, and `grep_search` are your only tools; no write or command tools are available.";
      case "opencode":
        return "- Provider tools: read, glob, and grep are your only tools; no write or command tools are available.";
      case "muse":
        return "- Provider tools: inspect with the CLI's read tools. Writes and shell execution are disabled on this lane.";
    }
  }
  switch (provider) {
    case "claude":
      return "- Provider tools: use `Edit`/`Write` for file changes and `Bash` for suitable checks; commands run inside the configured sandbox. Stop on a denied command.";
    case "codex":
      return "- Provider tools: use the CLI's file and shell tools inside its `workspace-write` sandbox.";
    case "grok":
      return "- Provider tools: use `search_replace` for edits and `run_terminal_cmd` for checks inside the configured workspace sandbox.";
    case "devin":
      return "- Provider tools: use sandboxed `exec` for every file creation, modification, and check, including the first file operation. Direct `edit` and `write` tools are disabled.";
    case "cursor":
      return "- Provider tools: use the available file and shell tools inside the configured workspace sandbox.";
    case "antigravity":
      return "- Provider tools: use file tools for edits and `run_command` for suitable checks in the native sandbox. Prefer foreground commands unless background work is needed; use `manage_task` or native completion to collect exit results. Repair ordinary check failures and rerun. Stop on any denial; never bypass the sandbox, select an external terminal, or alter agent/hooks policy.";
    case "opencode":
      return "- Provider tools: use file tools for edits and the shell tool for suitable checks inside the required sandbox. Use foreground commands. For the V2 shell tool, set timeout 0 unless the task supplies a deadline. For V1 Bash, omit timeout to retain its native default; zero is invalid. Stop on a denied command; never retry unsandboxed or change the configured shell.";
    case "muse":
      return "- Provider tools: use the CLI's file tools for edits and shell for suitable checks inside the default sandbox; approval stays on. Stop on a denied command.";
  }
}

export function invocationCommand(
  options: RunnerOptions,
  effectivePromptPath: string = options.promptPath,
  openCodeContract?: OpenCodeContract
): WorkerCommandSpec {
  if ((options.contract ?? "legacy") === "strict") {
    const verdict = strictRouteSupport({
      parent: options.parent,
      provider: options.provider,
      route: "external",
    });
    throw new UsageError(
      `strict worker contract is unsupported for ${options.provider} external lanes: ${verdict.reason}`
    );
  }
  switch (options.provider) {
    case "antigravity": {
      const files = antigravityLaneFiles(options);
      return {
        command: "agy",
        args: [
          "--print=", "--output-format", "stream-json", "--input-format", "stream-json",
          "--model", options.model, "--agent", files.agentName, "--sandbox",
          ...(options.mode === "read-only"
            ? ["--disable-slash-commands", "--add-dir", options.cwd]
            : ["--mode", "accept-edits", "--project", "default-cli-project"]),
        ],
        stdin: "prompt-ndjson",
        cwd: files.childCwd,
        workerGuidance: workerGuidance(options.provider, options.mode),
      };
    }
    case "opencode":
      return openCodeContract === undefined
        ? openCodeVersionProbe(options.mode)
        : openCodeInvocationCommand(options, openCodeContract);
    case "devin":
      return {
        command: "devin",
        args: [
          "--config",
          devinConfigPath(options),
          "--model",
          devinModel(options.model, options.effort),
          ...(options.mode === "isolated-write"
            ? ["--sandbox"]
            : ["--permission-mode", "auto"]),
          "--respect-workspace-trust",
          "false",
          "--prompt-file",
          devinPromptPath(options),
          "--export",
          devinExportPath(options),
          "--print",
        ],
        stdin: "none",
        workerGuidance: workerGuidance(options.provider, options.mode),
      };
    case "cursor":
      return {
        command: "cursor-agent",
        args: [
          "--print", "--output-format", "json", "--trust",
          "--model", options.model,
          "--workspace", options.cwd,
          "--sandbox", "enabled",
          ...(options.mode === "read-only" ? ["--mode", "ask"] : []),
        ],
        stdin: "prompt",
        workerGuidance: workerGuidance(options.provider, options.mode),
      };
    case "claude":
      return {
        command: "claude",
        args: [
          "-p",
          "--model",
          options.model,
          "--effort",
          options.effort,
          "--permission-mode",
          permissionMode(options.mode),
          "--setting-sources",
          options.mode === "isolated-write" ? "" : options.apiSpend === "deny" ? "" : "project",
          ...(options.mode === "isolated-write"
            ? ["--settings", CLAUDE_WRITER_SETTINGS]
            : []),
          "--strict-mcp-config",
          "--tools",
          claudeTools(options.mode),
          "--no-session-persistence",
          "--disable-slash-commands",
          "--disallowed-tools",
          claudeDeniedTools(options.mode),
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        stdin: "prompt",
        workerGuidance: workerGuidance(options.provider, options.mode),
      };
    case "codex":
      return {
        command: "codex",
        args: [
          "exec",
          "--model",
          options.model,
          "--config",
          effortOverride(options.effort),
          "--sandbox",
          codexSandbox(options.mode),
          "--cd",
          options.cwd,
          "--skip-git-repo-check",
          "--ephemeral",
          "--disable",
          "plugins",
          "--disable",
          "multi_agent",
          "--disable",
          "hooks",
          "--disable",
          "memories",
          "--json",
          "-",
        ],
        stdin: "prompt",
        workerGuidance: workerGuidance(options.provider, options.mode),
      };
    case "muse":
      return {
        command: "muse",
        args: [
          "exec",
          "--json",
          "--provider",
          "meta",
          "--model",
          options.model,
          "--reasoning-effort",
          options.effort,
          "--prompt-file",
          effectivePromptPath,
          "--workspace",
          options.cwd,
          ...(options.mode === "read-only" ? ["--disable-write", "--disable-shell"] : []),
          "--disable-web-tools",
          "--disable-reminders",
          "--disable-request-user-input",
          "--no-foreign-personal-context",
          "--no-session-log",
        ],
        stdin: "none",
        workerGuidance: workerGuidance(options.provider, options.mode),
      };
    case "grok":
      return {
        command: "grok",
        args: [
          "--prompt-file",
          effectivePromptPath,
          "--model",
          options.model,
          "--reasoning-effort",
          options.effort,
          "--permission-mode",
          permissionMode(options.mode),
          "--sandbox",
          grokSandbox(options.mode),
          "--tools",
          grokTools(options.mode),
          "--disallowed-tools",
          "Agent,search_tool,use_tool",
          "--output-format",
          "streaming-messages-json",
          "--cwd",
          options.cwd,
          "--no-subagents",
          "--disable-web-search",
          "--verbatim",
        ],
        stdin: "none",
        workerGuidance: workerGuidance(options.provider, options.mode),
      };
  }
}
