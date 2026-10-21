import { describe, expect, it } from "bun:test";
import {
  CLAUDE_WRITER_MINIMUM_VERSION,
  CLAUDE_WRITER_SETTINGS,
  claudeWriterVersionError,
  invocationCommand,
  openCodeAuthListCommand,
  preflightCommand,
} from "./commands.ts";
import type { RunnerOptions } from "./types.ts";

function options(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    parent: "claude",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "max",
    mode: "read-only",
    promptPath: "/tmp/prompt.md",
    cwd: "/tmp/worktree",
    outputPath: "/tmp/output.md",
    receiptPath: "/tmp/receipt.json",
    timeoutMs: null,
    apiSpend: null,
    ...overrides,
  };
}

describe("invocationCommand", () => {
  it("pins Codex model, effort, sandbox, cwd, and JSONL output", () => {
    const spec = invocationCommand(options());
    expect(spec.command).toBe("codex");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "exec",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="max"',
      "--sandbox",
      "read-only",
      "--cd",
      "/tmp/worktree",
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
    ]);
    expect(spec.args).not.toContain("danger-full-access");
  });

  it("passes Claude model, effort, permissions, and no-recursion controls", () => {
    const spec = invocationCommand(
      options({
        parent: "codex",
        provider: "claude",
        model: "fable",
      })
    );
    expect(spec.command).toBe("claude");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "-p",
      "--model",
      "fable",
      "--effort",
      "max",
      "--permission-mode",
      "plan",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--tools",
      "Read,Grep,Glob,Bash",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--disallowed-tools",
      "Agent,Task,WebSearch,WebFetch,Edit,Write,NotebookEdit",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(spec.args).not.toContain("bypassPermissions");
  });

  it("limits Grok to the assigned cwd and disables recursive agents", () => {
    const spec = invocationCommand(
      options({ provider: "grok", model: "grok-4.7", effort: "xhigh" })
    );
    expect(spec.command).toBe("grok");
    expect(spec.stdin).toBe("none");
    expect(spec.args).toEqual([
      "--prompt-file",
      "/tmp/prompt.md",
      "--model",
      "grok-4.7",
      "--reasoning-effort",
      "xhigh",
      "--permission-mode",
      "plan",
      "--sandbox",
      "read-only",
      "--tools",
      "read_file,grep,list_dir,run_terminal_cmd",
      "--disallowed-tools",
      "Agent,search_tool,use_tool",
      "--output-format",
      "streaming-messages-json",
      "--cwd",
      "/tmp/worktree",
      "--no-subagents",
      "--disable-web-search",
      "--verbatim",
    ]);
  });

  it("pins Muse model, effort, workspace, and read-only disables", () => {
    const spec = invocationCommand(
      options({ provider: "muse", model: "muse-spark-1.3", effort: "xhigh" })
    );
    expect(spec.command).toBe("muse");
    expect(spec.stdin).toBe("none");
    expect(spec.args).toEqual([
      "exec",
      "--json",
      "--provider",
      "meta",
      "--model",
      "muse-spark-1.3",
      "--reasoning-effort",
      "xhigh",
      "--prompt-file",
      "/tmp/prompt.md",
      "--workspace",
      "/tmp/worktree",
      "--disable-write",
      "--disable-shell",
      "--disable-web-tools",
      "--disable-reminders",
      "--disable-request-user-input",
      "--no-foreign-personal-context",
      "--no-session-log",
    ]);
  });

  it("keeps Muse writers on default approval and sandbox without bypasses", () => {
    const spec = invocationCommand(
      options({ provider: "muse", model: "muse-spark-1.3", mode: "isolated-write" })
    );
    expect(spec.args).not.toContain("--disable-write");
    expect(spec.args).not.toContain("--disable-shell");
    for (const bypass of ["--yolo", "--disable-approval", "--disable-sandbox", "--trust-workspace", "--approval-mode"]) {
      expect(spec.args).not.toContain(bypass);
    }
    expect(spec.args).toEqual(expect.arrayContaining(["--workspace", "/tmp/worktree", "--provider", "meta"]));
  });

  it("uses bounded write modes without blanket bypasses", () => {
    const codex = invocationCommand(options({ mode: "isolated-write" }));
    expect(codex.args).toEqual(
      expect.arrayContaining(["--sandbox", "workspace-write"])
    );
    const grok = invocationCommand(
      options({ provider: "grok", model: "grok-4.7", mode: "isolated-write" })
    );
    expect(grok.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "acceptEdits",
        "--sandbox",
        "workspace",
        "--tools",
        "read_file,grep,list_dir,run_terminal_cmd,search_replace",
      ])
    );
    expect(grok.args).not.toContain("--always-approve");

    const claude = invocationCommand(
      options({ provider: "claude", model: "fable", mode: "isolated-write" })
    );
    expect(claude.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "acceptEdits",
        "--tools",
        "Read,Write,Edit,Grep,Glob,Bash",
      ])
    );
  });

  it("covers low, medium, and high for every external provider", () => {
    const cases = [
      {
        provider: "claude" as const,
        model: "fable",
        flag: (effort: "low" | "medium" | "high") => ["--effort", effort],
      },
      {
        provider: "codex" as const,
        model: "gpt-5.6-sol",
        flag: (effort: "low" | "medium" | "high") => [
          "--config",
          `model_reasoning_effort="${effort}"`,
        ],
      },
      {
        provider: "grok" as const,
        model: "grok-4.7",
        flag: (effort: "low" | "medium" | "high") => [
          "--reasoning-effort",
          effort,
        ],
      },
      {
        provider: "muse" as const,
        model: "muse-spark-1.3",
        flag: (effort: "low" | "medium" | "high") => [
          "--reasoning-effort",
          effort,
        ],
      },
    ];
    for (const { provider, model, flag } of cases) {
      for (const effort of ["low", "medium", "high"] as const) {
        const spec = invocationCommand(options({ provider, model, effort }));
        expect(spec.args).toEqual(expect.arrayContaining(flag(effort)));
      }
    }
  });

  it("passes opaque model IDs through unchanged", () => {
    for (const { provider, model, effort } of [
      { provider: "claude" as const, model: "haiku", effort: "low" as const },
      { provider: "claude" as const, model: "claude-haiku-4-5", effort: "high" as const },
      { provider: "codex" as const, model: "gpt-7-nova", effort: "high" as const },
      { provider: "grok" as const, model: "grok-5", effort: "xhigh" as const },
      { provider: "devin" as const, model: "swe-1.7-lightning", effort: "default" as const },
    ]) {
      const spec = invocationCommand(options({ provider, model, effort }));
      expect(spec.args[spec.args.indexOf("--model") + 1]).toBe(model);
    }
  });

  it("pins every additional supported family in external argv", () => {
    const cases = [
      {
        provider: "claude" as const,
        model: "sonnet",
        flag: ["--model", "sonnet"],
      },
      {
        provider: "codex" as const,
        model: "gpt-6-astra",
        flag: ["--model", "gpt-6-astra"],
      },
      {
        provider: "codex" as const,
        model: "gpt-5.6-luna",
        flag: ["--model", "gpt-5.6-luna"],
      },
      {
        provider: "codex" as const,
        model: "gpt-5.6-terra",
        flag: ["--model", "gpt-5.6-terra"],
      },
    ];
    for (const { provider, model, flag } of cases) {
      const spec = invocationCommand(
        options({ provider, model, effort: "high" })
      );
      const modelIndex = spec.args.indexOf("--model");
      expect(spec.args.slice(modelIndex, modelIndex + 2)).toEqual(flag);
      const effortFlag =
        provider === "claude"
          ? ["--effort", "high"]
          : ["--config", 'model_reasoning_effort="high"'];
      const effortIndex = spec.args.indexOf(effortFlag[0]);
      expect(spec.args.slice(effortIndex, effortIndex + 2)).toEqual(effortFlag);
    }
  });
});

describe("Muse preflight probe", () => {
  it("probes auth and the requested model with one tiny minimal-effort call", () => {
    expect(preflightCommand("muse", "read-only", undefined, "muse-spark-1.3")).toEqual({
      command: "muse",
      args: [
        "exec",
        "--json",
        "--provider",
        "meta",
        "--model",
        "muse-spark-1.3",
        "--reasoning-effort",
        "minimal",
        "--disable-write",
        "--disable-shell",
        "--disable-web-tools",
        "--disable-reminders",
        "--disable-request-user-input",
        "--no-foreign-personal-context",
        "--no-session-log",
        "Reply with exactly: OK",
      ],
      stdin: "none",
    });
    expect(preflightCommand("muse", "isolated-write", undefined, "muse-spark-1.3")?.command).toBe("muse");
  });

  it("refuses a model-less Muse probe instead of verifying a default", () => {
    expect(() => preflightCommand("muse", "read-only")).toThrow("muse preflight requires the requested model");
  });
});

describe("Claude writer sandbox profile", () => {
  it("probes claude --version before writer workloads and skips read-only preflight", () => {
    expect(preflightCommand("claude", "isolated-write")).toEqual({
      command: "claude",
      args: ["--version"],
      stdin: "none",
    });
    expect(preflightCommand("claude", "read-only")).toBeNull();
  });

  it("accepts the minimum or newer stable versions and rejects older or malformed output", () => {
    for (const version of [CLAUDE_WRITER_MINIMUM_VERSION, "2.1.285 (Claude Code)", "2.1.286", "2.10.0", "3.0.0"]) {
      expect(claudeWriterVersionError(`${version}\n`), version).toBeNull();
    }
    for (const version of ["2.1.284", "2.1.284 (Claude Code)", "2.0.0", "1.99.0", "2.1.285-beta.1", "2.1.285 (unexpected)", "v2.1.285", "2.1", "", "unstable"]) {
      expect(claudeWriterVersionError(version), version).not.toBeNull();
    }
  });

  it("passes the exact measured sandbox profile inline for writers only", () => {
    const writer = invocationCommand(
      options({ provider: "claude", model: "opus", mode: "isolated-write" })
    );
    const settingsIndex = writer.args.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(writer.args[settingsIndex + 1]).toBe(CLAUDE_WRITER_SETTINGS);
    expect(JSON.parse(writer.args[settingsIndex + 1])).toEqual({
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        excludedCommands: [],
        filesystem: { disabled: false },
        network: { allowedDomains: [] },
      },
    });
    const readOnly = invocationCommand(
      options({ provider: "claude", model: "opus", mode: "read-only" })
    );
    expect(readOnly.args).not.toContain("--settings");
  });

  it("excludes project settings on writer lanes for every apiSpend value", () => {
    for (const apiSpend of ["deny", "approved", null] as const) {
      const spec = invocationCommand(
        options({ provider: "claude", model: "opus", mode: "isolated-write", apiSpend })
      );
      const sources = spec.args[spec.args.indexOf("--setting-sources") + 1];
      expect(sources, String(apiSpend)).toBe("");
    }
  });

  it("omits Claude auth preflight while retaining read-only settings restrictions", () => {
    const input = options({ provider: "claude", model: "opus", apiSpend: "deny" });
    const denied = invocationCommand(input);
    expect(denied.args[denied.args.indexOf("--setting-sources") + 1]).toBe("");
    const approved = invocationCommand({ ...input, apiSpend: "approved" });
    expect(approved.args[approved.args.indexOf("--setting-sources") + 1]).toBe("project");
  });
});

describe("worker guidance paired with invocation flags", () => {
  it("returns corresponding guidance for every provider and access mode", () => {
    for (const mode of ["read-only", "isolated-write"] as const) {
      for (const provider of ["claude", "codex", "grok", "devin", "cursor", "antigravity", "opencode", "muse"] as const) {
        const spec = invocationCommand(
          options({ provider, model: "any-model", effort: "default", mode })
        );
        expect(spec.workerGuidance.trim().length, `${provider} ${mode}`).toBeGreaterThan(0);
        expect(spec.workerGuidance, `${provider} ${mode}`).toContain("Provider tools:");
      }
    }
  });

  it("guides Devin writers through sandboxed exec and readers without exec", () => {
    const writer = invocationCommand(
      options({ provider: "devin", model: "swe-2", mode: "isolated-write" })
    );
    expect(writer.workerGuidance).toContain("sandboxed `exec`");
    const reader = invocationCommand(
      options({ provider: "devin", model: "swe-2", mode: "read-only" })
    );
    expect(reader.workerGuidance).toContain("`exec` is disabled");
    expect(reader.workerGuidance).not.toContain("sandboxed `exec`");
  });

  it("gives OpenCode writers sandboxed check guidance", () => {
    const spec = invocationCommand(options({provider:"opencode",model:"openai/gpt-6.1-sol",effort:"default",mode:"isolated-write"}));
    expect(spec.workerGuidance).toContain("file tools for edits");
    expect(spec.workerGuidance).toContain("required sandbox");
    expect(spec.workerGuidance).toContain("never retry unsandboxed");
  });

  it("directs Antigravity writers to native sandboxed checks", () => {
    for (const provider of ["antigravity"] as const) {
      const spec = invocationCommand(
        options({ provider, model: "any-model", effort: "default", mode: "isolated-write" })
      );
      expect(spec.workerGuidance, provider).toContain("`run_command`");
      expect(spec.workerGuidance, provider).toContain("`manage_task`");
    }
  });
});

describe("strict worker contract argv", () => {
  it("fails strict argv for every provider without a verified control", () => {
    for (const provider of ["claude", "codex", "grok", "devin", "cursor", "antigravity", "opencode", "muse"] as const) {
      expect(
        () => invocationCommand(options({ provider, mode: "isolated-write", contract: "strict" })),
        provider
      ).toThrow(/strict worker contract is unsupported/);
    }
  });
});

describe("OpenCode contract argv", () => {
  const opts = () => options({ provider: "opencode", model: "openai/gpt-6.1-sol", effort: "default", apiSpend: "approved" });
  it("probes the version banner before any route-specific argv", () => {
    expect(invocationCommand(opts()).args).toEqual(["--version"]);
    expect(preflightCommand("opencode", "read-only")?.args).toEqual(["--version"]);
  });
  it("derives V1 and V2 invocation argv from the selected contract", () => {
    const agent = invocationCommand(opts(), "/tmp/prompt.md", "v1").args;
    expect(agent.slice(0, 4)).toEqual(["run", "--pure", "--format", "json"]);
    expect(agent).toContain("--dir");
    expect(agent).not.toContain("--standalone");
    const v2 = invocationCommand(opts(), "/tmp/prompt.md", "v2").args;
    expect(v2.slice(0, 4)).toEqual(["run", "--standalone", "--format", "json"]);
    expect(v2).not.toContain("--pure");
    expect(v2).not.toContain("--dir");
  });
  it("derives preflight and auth argv from the same contract", () => {
    expect(preflightCommand("opencode", "read-only", "v1")?.args).toEqual(["--pure", "debug", "config"]);
    expect(preflightCommand("opencode", "read-only", "v2")?.args).toEqual(["debug", "config"]);
    expect(openCodeAuthListCommand("v1").args).toEqual(["--pure", "auth", "list"]);
    expect(openCodeAuthListCommand("v2").args).toEqual(["auth", "list", "--standalone", "--format", "json"]);
  });
});
