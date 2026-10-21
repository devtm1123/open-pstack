import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ModelPolicyError,
  assertCompleteSheet,
  eventAdvancesUnderPolicy,
  nextAttempt,
  parseSheet,
  renderSheet,
  resolveRole,
  validateSheet,
  type FallbackPolicy,
  type LanePolicy,
} from "./model-policy.ts";

const FIRST_RUN = `# pstack model configuration

Provider-qualified per-role choices.

# budget: unlimited (max)

feature, refactoring: grok:grok-4.7@xhigh
bug-fix: codex:gpt-5.6-sol@max
perf-issue: codex:gpt-5.6-sol@max
hillclimb: codex:gpt-5.6-sol@max
judgment and prose: claude:opus@max
hardest tasks: claude:opus@max
how explorer: grok:grok-4.7@xhigh
how explainer: claude:opus@max
why investigators, synthesizer: inherit-parent
reflect tooling, judgment, divergent, synthesizer: inherit-parent
arena runners: codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh, claude:opus@max
arena cross-judge pool: codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh, claude:opus@max
swarm workers: grok:grok-4.7@xhigh
architect runners: codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh, claude:opus@max
interrogate reviewers: codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh, claude:opus@max
`;

function parse(text: string) {
  return parseSheet(text);
}

describe("model sheet parser", () => {
  it("accepts exact optional Antigravity slugs only at default effort", () => {
    const line = "swarm workers: grok:grok-4.7@xhigh";
    const selected = parse(FIRST_RUN.replace(line, "swarm workers: antigravity:gemini-3.1-pro-high@default"));
    const row = selected.rows.find((entry) => entry.spec.header === "swarm workers");
    expect(row?.seats[0].attempts[0]).toEqual({kind:"descriptor",provider:"antigravity",model:"gemini-3.1-pro-high",effort:"default"});
    for (const descriptor of ["antigravity:auto@default", "antigravity:gemini-3.1-pro-high@high"]) {
      expect(() => parse(FIRST_RUN.replace(line, `swarm workers: ${descriptor}`))).toThrow(ModelPolicyError);
    }
  });
  it("accepts Muse descriptors with standard efforts in seats and chains", () => {
    const line = "swarm workers: grok:grok-4.7@xhigh";
    const selected = parse(FIRST_RUN.replace(line, "swarm workers: muse:muse-spark-1.3@max"));
    const row = selected.rows.find((entry) => entry.spec.header === "swarm workers");
    expect(row?.seats[0].attempts[0]).toEqual({kind:"descriptor",provider:"muse",model:"muse-spark-1.3",effort:"max"});
    const chained = parse(FIRST_RUN.replace(line, "swarm workers: grok:grok-4.7@xhigh -> muse:muse-wonder-1.0@high"));
    const seat = chained.rows.find((entry) => entry.spec.header === "swarm workers")?.seats[0];
    expect(seat?.attempts).toHaveLength(2);
    expect(seat?.attempts[1]).toEqual({kind:"descriptor",provider:"muse",model:"muse-wonder-1.0",effort:"high"});
  });
  it("parses a legacy single-attempt sheet with no fallback permission", () => {
    const model = parse(FIRST_RUN);
    expect(model.budget).toBe("unlimited (max)");
    expect(model.rows).toHaveLength(15);
    const feature = model.rows.find((row) => row.spec.header === "feature, refactoring");
    expect(feature?.seats).toHaveLength(1);
    expect(feature?.seats[0].attempts).toHaveLength(1);
    const arena = model.rows.find((row) => row.spec.header === "arena runners");
    expect(arena?.seats).toHaveLength(3);
    for (const seat of arena?.seats ?? []) expect(seat.attempts).toHaveLength(1);
  });

  it("parses comma-bearing role headers before the right-hand side", () => {
    const model = parse(FIRST_RUN);
    const why = model.rows.find((row) => row.spec.header === "why investigators, synthesizer");
    expect(why?.spec.roles).toEqual(["why investigators", "synthesizer"]);
    const reflect = model.rows.find(
      (row) => row.spec.header === "reflect tooling, judgment, divergent, synthesizer"
    );
    expect(reflect?.spec.roles).toEqual([
      "reflect tooling",
      "judgment",
      "divergent",
      "synthesizer",
    ]);
  });

  it("parses an ordered attempt chain per seat and preserves order", () => {
    const text = FIRST_RUN.replace(
      "feature, refactoring: grok:grok-4.7@xhigh",
      "feature, refactoring: grok:grok-4.7@xhigh -> codex:gpt-5.6-sol@high -> devin:swe-2@medium"
    );
    const model = parse(text);
    const row = model.rows.find((entry) => entry.spec.header === "feature, refactoring");
    expect(row?.seats[0].attempts.map((attempt) =>
      attempt.kind === "descriptor" ? `${attempt.provider}:${attempt.model}@${attempt.effort}` : attempt.alias
    )).toEqual([
      "grok:grok-4.7@xhigh",
      "codex:gpt-5.6-sol@high",
      "devin:swe-2@medium",
    ]);
  });

  it("rejects a fourth attempt, duplicates, and same-provider chains", () => {
    const feature = "feature, refactoring: ";
    for (const [name, rhs] of [
      ["four attempts", "grok:grok-4.7@xhigh -> codex:gpt-5.6-sol@high -> devin:swe-2@medium -> cursor:composer-2.5@default"],
      ["duplicate attempt", "grok:grok-4.7@xhigh -> grok:grok-4.7@xhigh"],
      ["same provider", "grok:grok-4.7@xhigh -> grok:grok-4.7@high"],
      ["two parent aliases", "inherit-parent -> auto"],
    ] as const) {
      expect(() => parse(FIRST_RUN.replace(`${feature}grok:grok-4.7@xhigh`, `${feature}${rhs}`)), name)
        .toThrow(ModelPolicyError);
    }
  });

  it("rejects fallback chains on native-only why/reflect roles", () => {
    const text = FIRST_RUN.replace(
      "why investigators, synthesizer: inherit-parent",
      "why investigators, synthesizer: inherit-parent -> grok:grok-4.7@xhigh"
    );
    expect(() => parse(text)).toThrow(/live MCP surface/);
  });

  it("rejects extra seats on single-model roles", () => {
    const text = FIRST_RUN.replace(
      "bug-fix: codex:gpt-5.6-sol@max",
      "bug-fix: codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh"
    );
    expect(() => parse(text)).toThrow(/exactly one seat/);
  });

  it("rejects unknown role rows, bad descriptors, and bad efforts", () => {
    for (const line of [
      "typo role: grok:grok-4.7@xhigh",
      "bug-fix: gpt-5.6-sol@max",
      "bug-fix: codex:gpt-5.6-sol@ludicrous",
      "bug-fix: codex:gpt 5.6@max",
      "bug-fix:",
    ]) {
      expect(() => parse(`${line}\n`), line).toThrow(ModelPolicyError);
    }
  });

  it("round-trips a canonical sheet byte-identically and stably", () => {
    const model = parse(FIRST_RUN);
    const rendered = renderSheet(model);
    expect(rendered).toBe(FIRST_RUN);
    expect(renderSheet(parse(rendered))).toBe(rendered);
  });

  it("round-trips chained rows and access metadata", () => {
    const text = FIRST_RUN.replace(
      "# budget: unlimited (max)",
      `# budget: large (xhigh)\n# access: {"provider":"codex","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user","plan":"ChatGPT Pro","note":"reported by user","observedAt":"2026-09-24"}`
    ).replace(
      "how explorer: grok:grok-4.7@xhigh",
      "how explorer: grok:grok-4.7@xhigh -> codex:gpt-5.6-sol@high"
    );
    const model = parse(text);
    expect(model.access).toHaveLength(1);
    expect(model.access[0]).toMatchObject({
      provider: "codex",
      funding: "included",
      capacity: "high",
      apiSpend: "deny",
      provenance: "user",
      plan: "ChatGPT Pro",
    });
    const rendered = renderSheet(model);
    expect(rendered).toBe(text);
    expect(renderSheet(parse(rendered))).toBe(rendered);
  });

  it("rejects malformed access metadata without blocking unrelated rows", () => {
    for (const access of [
      `# access: not-json`,
      `# access: {"provider":"codex"}`,
      `# access: {"provider":"codex","funding":"free","capacity":"high","apiSpend":"deny","provenance":"user"}`,
      `# access: {"provider":"codex","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user","extra":1}`,
      `# access: {"provider":"wat","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user"}`,
    ]) {
      expect(() => parse(FIRST_RUN.replace("# budget: unlimited (max)", `# budget: unlimited (max)\n${access}`)), access)
        .toThrow(ModelPolicyError);
    }
  });

  it("rejects a second access record for one provider", () => {
    const one = `# access: {"provider":"codex","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user"}`;
    const two = `# access: {"provider":"codex","funding":"metered","capacity":"unknown","apiSpend":"approved","provenance":"provider"}`;
    expect(() => parse(FIRST_RUN.replace("# budget: unlimited (max)", `# budget: unlimited (max)\n${one}\n${two}`)))
      .toThrow(/more than one access record/);
  });

  it("requires all 15 role rows and the architect minimum before a write", () => {
    const model = parse(FIRST_RUN);
    expect(() => assertCompleteSheet(model)).not.toThrow();
    const missing = FIRST_RUN.split("\n").filter((line) => !line.startsWith("hillclimb:")).join("\n");
    expect(() => assertCompleteSheet(parse(missing))).toThrow(/missing required role row: hillclimb/);
    const thin = FIRST_RUN.replace(
      "architect runners: codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh, claude:opus@max",
      "architect runners: codex:gpt-5.6-sol@max"
    );
    expect(() => assertCompleteSheet(parse(thin))).toThrow(/at least 2 seats/);
  });

  it("resolves a role into lanes with exhaustion groups and routes", () => {
    const text = FIRST_RUN.replace(
      "# budget: unlimited (max)",
      `# budget: unlimited (max)\n# access: {"provider":"grok","funding":"included","capacity":"standard","apiSpend":"deny","provenance":"user"}\n# access: {"provider":"codex","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user"}`
    ).replace(
      "how explorer: grok:grok-4.7@xhigh",
      "how explorer: grok:grok-4.7@xhigh -> inherit-parent"
    );
    const model = parse(text);
    const policy = resolveRole(model, "how explorer", "codex");
    expect(policy?.lanes).toHaveLength(1);
    const lane = policy?.lanes[0];
    expect(lane?.id).toBe("how explorer#1");
    expect(lane?.attempts.map((attempt) => [attempt.descriptor, attempt.route, attempt.exhaustionGroup, attempt.authorization.state])).toEqual([
      ["grok:grok-4.7@xhigh", "external", "grok", "allowed"],
      ["inherit-parent", "native", "codex", "allowed"],
    ]);
  });

  it("routes a same-parent Claude model externally when no shipped agent covers it", () => {
    const text = FIRST_RUN.replace(
      "swarm workers: grok:grok-4.7@xhigh",
      "swarm workers: claude:haiku@low"
    );
    const policy = resolveRole(parse(text), "swarm workers", "claude");
    expect(policy?.lanes[0].attempts[0]).toMatchObject({
      descriptor: "claude:haiku@low",
      route: "external",
      exhaustionGroup: "claude",
      authorization: { state: "allowed" },
    });
  });

  it("keeps shipped Claude agents native and other parents external", () => {
    const text = FIRST_RUN.replace(
      "swarm workers: grok:grok-4.7@xhigh",
      "swarm workers: claude:opus@max"
    );
    expect(
      resolveRole(parse(text), "swarm workers", "claude")?.lanes[0].attempts[0].route
    ).toBe("native");
    expect(
      resolveRole(parse(text), "swarm workers", "codex")?.lanes[0].attempts[0].route
    ).toBe("external");
  });

  it("covers every Codex model natively on a Codex parent", () => {
    const text = FIRST_RUN.replace(
      "swarm workers: grok:grok-4.7@xhigh",
      "swarm workers: codex:gpt-7-nova@high"
    );
    expect(
      resolveRole(parse(text), "swarm workers", "codex")?.lanes[0].attempts[0].route
    ).toBe("native");
    expect(
      resolveRole(parse(text), "swarm workers", "claude")?.lanes[0].attempts[0].route
    ).toBe("external");
  });

  it("accepts unknown model IDs on every supported provider as external lanes", () => {
    for (const descriptor of [
      "claude:haiku@low",
      "claude:claude-haiku-4-5@high",
      "codex:gpt-7-nova@high",
      "grok:grok-5@xhigh",
      "devin:swe-1.7-lightning@default",
      "cursor:composer-9@default",
      "antigravity:gemini-3.3-pro-high@default",
      "opencode:openai/gpt-6@default",
    ]) {
      const text = FIRST_RUN.replace(
        "swarm workers: grok:grok-4.7@xhigh",
        `swarm workers: ${descriptor}`
      );
      const attempt = resolveRole(parse(text), "swarm workers", "claude")
        ?.lanes[0].attempts[0];
      expect(attempt?.descriptor, descriptor).toBe(descriptor);
      expect(attempt?.route, descriptor).toBe("external");
    }
  });

  it("resolves a fixture native agent without code changes", () => {
    const agentsDir = mkdtempSync(join(tmpdir(), "pstack-policy-agents-"));
    try {
      writeFileSync(
        join(agentsDir, "pstack-nova-medium.md"),
        "---\nname: pstack-nova-medium\nmodel: nova\neffort: medium\nbackground: true\n---\nbody\n"
      );
      const text = FIRST_RUN.replace(
        "swarm workers: grok:grok-4.7@xhigh",
        "swarm workers: claude:nova@medium"
      );
      const model = parse(text);
      expect(
        resolveRole(model, "swarm workers", "claude", agentsDir)?.lanes[0].attempts[0].route
      ).toBe("native");
      expect(
        resolveRole(model, "swarm workers", "claude")?.lanes[0].attempts[0].route
      ).toBe("external");
      expect(
        resolveRole(model, "swarm workers", "claude", agentsDir)?.lanes[0].attempts[0].exhaustionGroup
      ).toBe("claude");
    } finally {
      rmSync(agentsDir, { recursive: true, force: true });
    }
  });

  it("resolves leaf roles to their shared row", () => {
    const model = parse(FIRST_RUN);
    expect(resolveRole(model, "feature", "claude")?.header).toBe("feature, refactoring");
    expect(resolveRole(model, "refactoring", "claude")?.header).toBe("feature, refactoring");
    expect(resolveRole(model, "how explorer", "claude")?.header).toBe("how explorer");
    expect(resolveRole(model, "nonexistent", "claude")).toBeNull();
  });

  it("rejects a chain whose fallback resolves to the parent's account", () => {
    const text = FIRST_RUN.replace(
      "# budget: unlimited (max)",
      `# budget: unlimited (max)\n# access: {"provider":"codex","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user"}\n# access: {"provider":"claude","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user"}`
    ).replace(
      "how explorer: grok:grok-4.7@xhigh",
      "how explorer: codex:gpt-5.6-sol@max -> inherit-parent"
    );
    const model = parse(text);
    expect(() => resolveRole(model, "how explorer", "codex")).toThrow(/codex account/);
    expect(() => resolveRole(model, "how explorer", "claude")).not.toThrow();
  });

  it("applies access-fact apiSpend to resolved attempts", () => {
    const text = FIRST_RUN.replace(
      "# budget: unlimited (max)",
      `# budget: unlimited (max)\n# access: {"provider":"grok","funding":"included","capacity":"standard","apiSpend":"approved","provenance":"user"}`
    );
    const policy = resolveRole(parse(text), "how explorer", "claude");
    expect(policy?.lanes[0].attempts[0].apiSpend).toBe("approved");
    expect(resolveRole(parse(FIRST_RUN), "how explorer", "claude")?.lanes[0].attempts[0].apiSpend).toBe("unset");
  });
});

describe("saved fallback policy", () => {
  const BROAD = '# fallback: {"on":["usage-exhausted","route-unavailable","terminal-failure","deadline-exceeded"]}';

  it("defaults to quota-only when no fallback line is saved", () => {
    const model = parse(FIRST_RUN);
    expect(model.fallback).toBeNull();
    expect(resolveRole(model, "how explorer", "claude")?.lanes[0].fallback)
      .toEqual({ on: ["usage-exhausted"] });
  });

  it("parses and propagates a declared broad policy", () => {
    const facts = '# access: {"provider":"grok","funding":"included","capacity":"standard","apiSpend":"deny","provenance":"user"}\n# access: {"provider":"codex","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user"}\n# access: {"provider":"claude","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user"}';
    const text = FIRST_RUN.replace("# budget: unlimited (max)", `# budget: unlimited (max)\n${BROAD}\n${facts}`);
    const model = parse(text);
    expect(model.fallback).toEqual({
      on: ["usage-exhausted", "route-unavailable", "terminal-failure", "deadline-exceeded"],
    });
    expect(resolveRole(model, "how explorer", "claude")?.lanes[0].fallback ?? null)
      .toEqual(model.fallback);
  });

  it("round-trips the fallback declaration byte-identically", () => {
    const text = FIRST_RUN.replace("# budget: unlimited (max)", `# budget: unlimited (max)\n${BROAD}`);
    const rendered = renderSheet(parse(text));
    expect(rendered).toBe(text);
    expect(renderSheet(parse(rendered))).toBe(rendered);
  });

  it("accepts an explicit narrower or empty policy as a real declaration", () => {
    for (const line of [
      '# fallback: {"on":["usage-exhausted"]}',
      '# fallback: {"on":[]}',
    ]) {
      const text = FIRST_RUN.replace("# budget: unlimited (max)", `# budget: unlimited (max)\n${line}`);
      expect(() => parse(text), line).not.toThrow();
    }
  });

  it("rejects malformed, unknown, and duplicate policy entries", () => {
    for (const line of [
      "# fallback: not-json",
      '# fallback: []',
      '# fallback: {"on":"usage-exhausted"}',
      '# fallback: {"on":["bogus"]}',
      '# fallback: {"on":[1]}',
      '# fallback: {"on":["usage-exhausted","usage-exhausted"]}',
      '# fallback: {"on":["usage-exhausted"],"reasons":[]}',
    ]) {
      const text = FIRST_RUN.replace("# budget: unlimited (max)", `# budget: unlimited (max)\n${line}`);
      expect(() => parse(text), line).toThrow(ModelPolicyError);
    }
  });

  it("recognizes a fallback declaration only at the start of a comment", () => {
    for (const comment of [
      `# note: the documented syntax is # fallback: {"on":["route-unavailable"]}`,
      `# access: {"provider":"grok","funding":"included","capacity":"standard","apiSpend":"deny","provenance":"user","note":"see # fallback: examples"} `,
    ]) {
      const model = parse(
        FIRST_RUN.replace("# budget: unlimited (max)", `# budget: unlimited (max)\n${comment}`)
      );
      expect(model.fallback, comment).toBeNull();
    }
  });

  it("rejects a second fallback declaration wherever it appears", () => {
    for (const text of [
      FIRST_RUN.replace("# budget: unlimited (max)", `# budget: unlimited (max)\n${BROAD}\n${BROAD}`),
      `${FIRST_RUN.trimEnd()}\n${BROAD}\n`.replace(
        "# budget: unlimited (max)",
        `# budget: unlimited (max)\n${BROAD}`
      ),
      FIRST_RUN.replace("hillclimb:", `${BROAD}\nhillclimb:`).replace(
        "# budget: unlimited (max)",
        `# budget: unlimited (max)\n# fallback: {"on":["route-unavailable"]}`
      ),
    ]) {
      expect(() => parse(text)).toThrow(/more than one # fallback/);
    }
  });

  it("treats an explicit fallback line as policy-enabled metadata", () => {
    const text = `how explorer: grok:grok-4.7@xhigh\n${BROAD}\n`;
    const model = parse(text);
    expect(() => resolveRole(model, "bug-fix", "claude")).toThrow(
      /policy-enabled sheet has no role/
    );
  });
});

describe("model sheet separators", () => {
  it("rejects empty seats instead of silently filtering them", () => {
    for (const row of [
      "swarm workers: inherit-parent,, inherit-parent",
      "swarm workers: inherit-parent,",
      "swarm workers: ,inherit-parent",
      "arena runners: codex:gpt-5.6-sol@max,, grok:grok-4.7@xhigh",
    ]) {
      expect(() => parse(`${row}\n`), row).toThrow(/empty seat/);
    }
  });

  it("parses documented rows with a bare colon or tab separator", () => {
    for (const row of [
      "swarm workers:inherit-parent",
      "swarm workers:\tinherit-parent",
      "swarm workers:  inherit-parent",
    ]) {
      const model = parse(`${row}\n`);
      expect(model.rows, row).toHaveLength(1);
      expect(model.rows[0].seats[0].attempts).toEqual([
        { kind: "alias", alias: "inherit-parent" },
      ]);
    }
  });

  it("still reports colon-separated rows with unknown headers", () => {
    expect(() => parse("typo role: grok:grok-4.7@xhigh\n")).toThrow(
      /unknown role row header/
    );
    expect(() => parse("typo role:\tgrok:grok-4.7@xhigh\n")).toThrow(
      /unknown role row header/
    );
  });
});

describe("chain funding authorization", () => {
  const ACCESS = {
    grokIncluded: '# access: {"provider":"grok","funding":"included","capacity":"standard","apiSpend":"deny","provenance":"user"}',
    grokMeteredDenied: '# access: {"provider":"grok","funding":"metered","capacity":"standard","apiSpend":"deny","provenance":"user"}',
    grokMeteredApproved: '# access: {"provider":"grok","funding":"metered","capacity":"standard","apiSpend":"approved","provenance":"user"}',
    grokUnknown: '# access: {"provider":"grok","funding":"unknown","capacity":"unknown","apiSpend":"deny","provenance":"provider"}',
    codexIncluded: '# access: {"provider":"codex","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user"}',
    devinIncluded: '# access: {"provider":"devin","funding":"included","capacity":"standard","apiSpend":"deny","provenance":"user"}',
    devinUnknown: '# access: {"provider":"devin","funding":"unknown","capacity":"unknown","apiSpend":"deny","provenance":"provider"}',
  } as const;

  function sheetWith(row: string, access: readonly string[]): string {
    return FIRST_RUN.replace(
      "# budget: unlimited (max)",
      ["# budget: unlimited (max)", ...access].join("\n")
    ).replace("swarm workers: grok:grok-4.7@xhigh", row);
  }

  it("rejects a multi-attempt chain when any attempt lacks an access fact", () => {
    const model = parse(
      sheetWith("swarm workers: grok:grok-4.7@xhigh -> devin:swe-2@high", [
        ACCESS.grokIncluded,
      ])
    );
    expect(() => resolveRole(model, "swarm workers", "codex")).toThrow(
      /no access fact for provider devin|confirmed funding/
    );
    const bare = parse(
      sheetWith("swarm workers: grok:grok-4.7@xhigh -> devin:swe-2@high", [])
    );
    expect(() => resolveRole(bare, "swarm workers", "codex")).toThrow(
      /confirmed funding/
    );
  });

  it("authorizes included and metered-approved routes, never unknown funding", () => {
    const authorized = resolveRole(
      parse(
        sheetWith("swarm workers: grok:grok-4.7@xhigh -> devin:swe-2@high", [
          ACCESS.grokIncluded,
          ACCESS.devinIncluded,
        ])
      ),
      "swarm workers",
      "codex"
    );
    expect(authorized?.lanes[0].attempts.map((attempt) => attempt.authorization.state)).toEqual([
      "allowed",
      "allowed",
    ]);

    const metered = resolveRole(
      parse(
        sheetWith("swarm workers: grok:grok-4.7@xhigh -> devin:swe-2@high", [
          ACCESS.grokMeteredApproved,
          ACCESS.devinIncluded,
        ])
      ),
      "swarm workers",
      "codex"
    );
    expect(metered?.lanes[0].attempts[0]).toMatchObject({
      authorization: { state: "allowed" },
      apiSpend: "approved",
      funding: "metered",
    });

    const unknown = resolveRole(
      parse(
        sheetWith("swarm workers: grok:grok-4.7@xhigh -> devin:swe-2@high", [
          ACCESS.grokUnknown,
          ACCESS.devinUnknown,
        ])
      ),
      "swarm workers",
      "codex"
    );
    for (const attempt of unknown?.lanes[0].attempts ?? []) {
      expect(attempt.authorization).toMatchObject({ state: "blocked" });
      if (attempt.authorization.state === "blocked") {
        expect(attempt.authorization.reason).toContain("unknown");
      }
    }

    const denied = resolveRole(
      parse(
        sheetWith("swarm workers: grok:grok-4.7@xhigh -> devin:swe-2@high", [
          ACCESS.grokMeteredDenied,
          ACCESS.devinIncluded,
        ])
      ),
      "swarm workers",
      "codex"
    );
    expect(denied?.lanes[0].attempts[0].authorization.state).toBe("blocked");
    expect(denied?.lanes[0].attempts[1].authorization.state).toBe("allowed");
  });

  it("uses the parent provider's access fact for native aliases", () => {
    const policy = resolveRole(
      parse(
        sheetWith("swarm workers: inherit-parent -> grok:grok-4.7@xhigh", [
          ACCESS.codexIncluded,
          ACCESS.grokMeteredApproved,
        ])
      ),
      "swarm workers",
      "codex"
    );
    const [alias, external] = policy?.lanes[0].attempts ?? [];
    expect(alias).toMatchObject({
      exhaustionGroup: "codex",
      route: "native",
      apiSpend: "deny",
      funding: "included",
      authorization: { state: "allowed" },
    });
    expect(external).toMatchObject({
      exhaustionGroup: "grok",
      apiSpend: "approved",
      authorization: { state: "allowed" },
    });
  });

  it("keeps legacy single-attempt rows authorized without policy, and only legacy", () => {
    const legacy = resolveRole(parse(FIRST_RUN), "how explorer", "claude");
    expect(legacy?.lanes[0].attempts[0]).toMatchObject({
      authorization: { state: "allowed" },
      apiSpend: "unset",
      funding: "unset",
      exhaustionGroup: "grok",
    });
    const unknown = resolveRole(
      parse(
        FIRST_RUN.replace(
          "# budget: unlimited (max)",
          `# budget: unlimited (max)\n${ACCESS.grokUnknown}`
        )
      ),
      "how explorer",
      "claude"
    );
    expect(unknown?.lanes[0].attempts[0].authorization.state).toBe("blocked");
  });

  it("requires an access fact for every configured route once a sheet is policy-enabled", () => {
    const model = parse(
      sheetWith("swarm workers: grok:grok-4.7@xhigh", [ACCESS.codexIncluded])
    );
    expect(() => resolveRole(model, "swarm workers", "codex")).toThrow(
      /no access fact for provider grok/
    );
    const alias = parse(
      sheetWith("swarm workers: inherit-parent", [ACCESS.codexIncluded])
    );
    expect(() => resolveRole(alias, "swarm workers", "claude")).toThrow(
      /no access fact for provider claude/
    );
    expect(
      resolveRole(alias, "swarm workers", "codex")?.lanes[0].attempts[0]
    ).toMatchObject({ authorization: { state: "allowed" }, apiSpend: "deny" });
  });
});

describe("nextAttempt decision", () => {
  const QUOTA_ONLY = { on: ["usage-exhausted"] } as const;
  const lane: LanePolicy = {
    id: "how explorer#1",
    fallback: QUOTA_ONLY,
    attempts: [
      { descriptor: "grok:grok-4.7@xhigh", attempt: { kind: "descriptor", provider: "grok", model: "grok-4.7", effort: "xhigh" }, exhaustionGroup: "grok", funding: "included", apiSpend: "deny", route: "external", authorization: { state: "allowed" } },
      { descriptor: "codex:gpt-5.6-sol@high", attempt: { kind: "descriptor", provider: "codex", model: "gpt-5.6-sol", effort: "high" }, exhaustionGroup: "codex", funding: "included", apiSpend: "deny", route: "external", authorization: { state: "allowed" } },
      { descriptor: "inherit-parent", attempt: { kind: "alias", alias: "inherit-parent" }, exhaustionGroup: "claude", funding: "unset", apiSpend: "unset", route: "native", authorization: { state: "allowed" } },
    ],
  };

  it("launches the primary, stops on success, and advances on exhaustion", () => {
    expect(nextAttempt(lane, [], new Set(), "read-only")).toMatchObject({ kind: "launch", attemptIndex: 0 });
    expect(nextAttempt(lane, [
      { attemptIndex: 0, status: "complete" },
      { attemptIndex: 99, status: "usage-exhausted", processStarted: false },
    ], new Set(["grok"]), "read-only")).toMatchObject({ kind: "stop", reason: "complete" });
    expect(nextAttempt(lane, [{ attemptIndex: 0, status: "complete" }], new Set(), "read-only"))
      .toMatchObject({ kind: "stop", reason: "complete" });
    expect(nextAttempt(lane, [{ attemptIndex: 0, status: "usage-exhausted", processStarted: true }], new Set(["grok"]), "read-only"))
      .toMatchObject({ kind: "launch", attemptIndex: 1 });
  });

  it("skips attempts on accounts exhausted elsewhere in the run", () => {
    const decision = nextAttempt(
      lane,
      [{ attemptIndex: 0, status: "usage-exhausted", processStarted: false }],
      new Set(["grok", "codex"]),
      "read-only"
    );
    expect(decision).toMatchObject({ kind: "launch", attemptIndex: 2 });
  });

  it("stops when the chain is exhausted and never replays an attempt", () => {
    const decision = nextAttempt(
      lane,
      [
        { attemptIndex: 0, status: "usage-exhausted", processStarted: true },
        { attemptIndex: 1, status: "usage-exhausted", processStarted: true },
        { attemptIndex: 2, status: "usage-exhausted", processStarted: true },
      ],
      new Set(["grok", "codex", "claude"]),
      "read-only"
    );
    expect(decision).toMatchObject({ kind: "stop", reason: "chain-exhausted" });
  });

  it("never advances on an ineligible failure", () => {
    for (const status of ["failed"] as const) {
      expect(nextAttempt(lane, [{ attemptIndex: 0, status }], new Set(), "read-only"))
        .toMatchObject({ kind: "stop", reason: "not-eligible" });
    }
  });

  it("stops a started or unknown writer for inspection instead of replaying", () => {
    for (const processStarted of [true, undefined]) {
      const decision = nextAttempt(
        lane,
        [{ attemptIndex: 0, status: "usage-exhausted", processStarted }],
        new Set(["grok"]),
        "isolated-write"
      );
      expect(decision, String(processStarted)).toMatchObject({ kind: "inspect", reason: "started-writer" });
    }
  });

  it("advances a writer only when exhaustion is proved before process start", () => {
    const decision = nextAttempt(
      lane,
      [{ attemptIndex: 0, status: "usage-exhausted", processStarted: false }],
      new Set(["grok"]),
      "isolated-write"
    );
    expect(decision).toMatchObject({ kind: "launch", attemptIndex: 1 });
  });

  it("stops on an unauthorized next candidate instead of skipping to a later model", () => {
    const blockedLane: LanePolicy = {
      id: "swarm workers#1",
      fallback: QUOTA_ONLY,
      attempts: [
        { descriptor: "grok:grok-4.7@xhigh", attempt: { kind: "descriptor", provider: "grok", model: "grok-4.7", effort: "xhigh" }, exhaustionGroup: "grok", funding: "unknown", apiSpend: "deny", route: "external", authorization: { state: "blocked", reason: "funding unknown" } },
        lane.attempts[1],
      ],
    };
    expect(nextAttempt(blockedLane, [], new Set(), "read-only"))
      .toMatchObject({ kind: "stop", reason: "unauthorized" });
    expect(
      nextAttempt(
        blockedLane,
        [{ attemptIndex: 1, status: "usage-exhausted", processStarted: true }],
        new Set(["codex"]),
        "read-only"
      )
    ).toMatchObject({ kind: "stop", reason: "chain-exhausted" });
  });

  it("stops unauthorized on a blocked route even when its provider is already exhausted", () => {
    const blocked: LanePolicy["attempts"][number] = {
      descriptor: "devin:swe-2@high",
      attempt: { kind: "descriptor", provider: "devin", model: "swe-2", effort: "high" },
      exhaustionGroup: "devin",
      funding: "unknown",
      apiSpend: "deny",
      route: "external",
      authorization: { state: "blocked", reason: "funding unknown" },
    };
    const blockedLane: LanePolicy = {
      id: "swarm workers#1",
      fallback: QUOTA_ONLY,
      attempts: [blocked, lane.attempts[1]],
    };
    expect(nextAttempt(blockedLane, [], new Set(["devin"]), "read-only"))
      .toMatchObject({ kind: "stop", reason: "unauthorized" });
    const chained: LanePolicy = {
      id: "swarm workers#1",
      fallback: QUOTA_ONLY,
      attempts: [lane.attempts[0], blocked, lane.attempts[2]],
    };
    expect(
      nextAttempt(
        chained,
        [{ attemptIndex: 0, status: "usage-exhausted", processStarted: false }],
        new Set(["grok", "devin"]),
        "read-only"
      )
    ).toMatchObject({ kind: "stop", reason: "unauthorized" });
  });

  it("advances only on prior usage-exhaustion, never past missing permission", () => {
    const sheet = `# access: {"provider":"grok","funding":"unknown","capacity":"unknown","apiSpend":"deny","provenance":"provider"}\n# access: {"provider":"codex","funding":"included","capacity":"high","apiSpend":"deny","provenance":"user"}\nswarm workers: grok:grok-4.7@xhigh -> inherit-parent\n`;
    const policy = resolveRole(parseSheet(sheet), "swarm workers", "codex");
    expect(nextAttempt(policy!.lanes[0], [], new Set(), "read-only"))
      .toMatchObject({ kind: "stop", reason: "unauthorized" });
  });
});

describe("nextAttempt under a broad fallback policy", () => {
  const BROAD = { on: ["usage-exhausted", "route-unavailable", "terminal-failure", "deadline-exceeded"] } as const;
  const QUOTA_ONLY = { on: ["usage-exhausted"] } as const;

  function broadLane(fallback: FallbackPolicy = BROAD): LanePolicy {
    return {
      id: "how explorer#1",
      fallback,
      attempts: [
        { descriptor: "grok:grok-4.7@xhigh", attempt: { kind: "descriptor", provider: "grok", model: "grok-4.7", effort: "xhigh" }, exhaustionGroup: "grok", funding: "included", apiSpend: "deny", route: "external", authorization: { state: "allowed" } },
        { descriptor: "codex:gpt-5.6-sol@high", attempt: { kind: "descriptor", provider: "codex", model: "gpt-5.6-sol", effort: "high" }, exhaustionGroup: "codex", funding: "included", apiSpend: "deny", route: "external", authorization: { state: "allowed" } },
      ],
    };
  }

  it("advances on each authorized outcome and only those", () => {
    const lane = broadLane();
    for (const status of ["usage-exhausted", "route-unavailable", "terminal-failure", "deadline-exceeded"] as const) {
      expect(
        nextAttempt(lane, [{ attemptIndex: 0, status, processStarted: true }], new Set(["grok"]), "read-only"),
        status
      ).toMatchObject({ kind: "launch", attemptIndex: 1 });
    }
    for (const status of ["route-unavailable", "terminal-failure", "deadline-exceeded", "failed"] as const) {
      expect(
        nextAttempt(broadLane(QUOTA_ONLY), [{ attemptIndex: 0, status, processStarted: true }], new Set(), "read-only"),
        `quota-only ${status}`
      ).toMatchObject({ kind: "stop", reason: "not-eligible" });
    }
  });

  it("honors a narrowed saved policy instead of assuming every reason", () => {
    const lane = broadLane({ on: ["usage-exhausted", "route-unavailable"] });
    expect(
      nextAttempt(lane, [{ attemptIndex: 0, status: "route-unavailable", processStarted: true }], new Set(), "read-only")
    ).toMatchObject({ kind: "launch", attemptIndex: 1 });
    for (const status of ["terminal-failure", "deadline-exceeded"] as const) {
      expect(
        nextAttempt(lane, [{ attemptIndex: 0, status, processStarted: true }], new Set(), "read-only"),
        status
      ).toMatchObject({ kind: "stop", reason: "not-eligible" });
    }
  });

  it("keeps failed terminal under every policy", () => {
    for (const fallback of [BROAD, QUOTA_ONLY]) {
      expect(
        nextAttempt(broadLane(fallback), [{ attemptIndex: 0, status: "failed", processStarted: true }], new Set(), "read-only")
      ).toMatchObject({ kind: "stop", reason: "not-eligible" });
    }
  });

  it("returns inspect before advancing a started writer, then honors the recorded verdict", () => {
    const lane = broadLane();
    const failed = { attemptIndex: 0, status: "terminal-failure" as const, processStarted: true };
    expect(
      nextAttempt(lane, [failed], new Set(), "isolated-write")
    ).toMatchObject({ kind: "inspect", reason: "started-writer" });
    expect(
      nextAttempt(
        lane,
        [{ ...failed, inspection: { state: "clear", evidenceRef: "worktree-review#1" } }],
        new Set(),
        "isolated-write"
      )
    ).toMatchObject({ kind: "launch", attemptIndex: 1 });
    expect(
      nextAttempt(
        lane,
        [{ ...failed, inspection: { state: "unsafe", evidenceRef: "worktree-review#1" } }],
        new Set(),
        "isolated-write"
      )
    ).toMatchObject({ kind: "stop", reason: "unsafe-writer" });
    expect(
      nextAttempt(
        lane,
        [{ ...failed, inspection: { state: "clear", evidenceRef: "  " } }],
        new Set(),
        "isolated-write"
      )
    ).toMatchObject({ kind: "inspect", reason: "started-writer" });
  });

  it("does not inspect a writer whose process provably never started", () => {
    expect(
      nextAttempt(
        broadLane(),
        [{ attemptIndex: 0, status: "terminal-failure", processStarted: false }],
        new Set(),
        "isolated-write"
      )
    ).toMatchObject({ kind: "launch", attemptIndex: 1 });
  });

  it("vetoes continuation on an explicit unsafe verdict regardless of start or access", () => {
    const lane = broadLane();
    for (const access of ["read-only", "isolated-write"] as const) {
      for (const processStarted of [true, false, undefined] as const) {
        const event = {
          attemptIndex: 0,
          status: "route-unavailable" as const,
          processStarted,
          inspection: { state: "unsafe" as const, evidenceRef: "diff-review#1" },
        };
        expect(
          nextAttempt(lane, [event], new Set(), access),
          `${access} processStarted=${String(processStarted)}`
        ).toMatchObject({ kind: "stop", reason: "unsafe-writer" });
      }
    }
  });

  it("advances a proved-not-started writer with a clear verdict or no inspection", () => {
    const lane = broadLane();
    for (const access of ["read-only", "isolated-write"] as const) {
      for (const inspection of [
        undefined,
        { state: "clear" as const, evidenceRef: "preflight-log#1" },
      ]) {
        expect(
          nextAttempt(
            lane,
            [{ attemptIndex: 0, status: "route-unavailable", processStarted: false, inspection }],
            new Set(),
            access
          ),
          `${access} inspection=${JSON.stringify(inspection)}`
        ).toMatchObject({ kind: "launch", attemptIndex: 1 });
      }
    }
  });

  it("never lets recorded history advance past an unsafe verdict", () => {
    const lane = broadLane();
    for (const access of ["read-only", "isolated-write"] as const) {
      for (const processStarted of [true, false, undefined] as const) {
        const event = {
          attemptIndex: 0,
          status: "route-unavailable" as const,
          processStarted,
          inspection: { state: "unsafe" as const, evidenceRef: "diff-review#1" },
        };
        expect(
          eventAdvancesUnderPolicy(lane, event, access),
          `${access} processStarted=${String(processStarted)}`
        ).toBe(false);
      }
    }
  });

  it("advances recorded history only through the started-writer gate", () => {
    const lane = broadLane();
    const failed = { attemptIndex: 0, status: "terminal-failure" as const };
    expect(
      eventAdvancesUnderPolicy(lane, { ...failed, processStarted: false }, "isolated-write")
    ).toBe(true);
    expect(
      eventAdvancesUnderPolicy(lane, { ...failed, processStarted: true }, "isolated-write")
    ).toBe(false);
    expect(
      eventAdvancesUnderPolicy(lane, { ...failed }, "isolated-write")
    ).toBe(false);
    expect(
      eventAdvancesUnderPolicy(
        lane,
        { ...failed, processStarted: true, inspection: { state: "clear", evidenceRef: "diff-review#1" } },
        "isolated-write"
      )
    ).toBe(true);
    expect(
      eventAdvancesUnderPolicy(lane, { ...failed, processStarted: true }, "read-only")
    ).toBe(true);
  });

  it("still stops on an unauthorized route and ends a finite exhausted chain", () => {
    const blocked: LanePolicy = {
      id: "swarm workers#1",
      fallback: BROAD,
      attempts: [
        broadLane().attempts[0],
        { descriptor: "devin:swe-2@high", attempt: { kind: "descriptor", provider: "devin", model: "swe-2", effort: "high" }, exhaustionGroup: "devin", funding: "unknown", apiSpend: "deny", route: "external", authorization: { state: "blocked", reason: "funding unknown" } },
      ],
    };
    expect(
      nextAttempt(blocked, [{ attemptIndex: 0, status: "terminal-failure", processStarted: false }], new Set(), "read-only")
    ).toMatchObject({ kind: "stop", reason: "unauthorized" });
    expect(
      nextAttempt(
        broadLane(),
        [
          { attemptIndex: 0, status: "route-unavailable", processStarted: false },
          { attemptIndex: 1, status: "terminal-failure", processStarted: true },
        ],
        new Set(),
        "read-only"
      )
    ).toMatchObject({ kind: "stop", reason: "chain-exhausted" });
  });
});

describe("validateSheet", () => {
  const FACT = (provider: string, funding: string = "included") =>
    `# access: {"provider":"${provider}","funding":"${funding}","capacity":"high","apiSpend":"deny","provenance":"user"}`;

  const FULL_FACTS = [FACT("grok"), FACT("codex"), FACT("claude")].join("\n");

  function sheetWith(facts: string, replacements: readonly (readonly [string, string])[] = []): string {
    let text = FIRST_RUN.replace(
      "# budget: unlimited (max)",
      ["# budget: unlimited (max)", facts].filter((line) => line.length > 0).join("\n")
    );
    for (const [from, to] of replacements) text = text.replace(from, to);
    return text;
  }

  it("accepts a complete policy sheet with authorized facts for every route", () => {
    const model = parse(sheetWith(FULL_FACTS));
    for (const parent of ["claude", "codex"] as const) {
      expect(() => validateSheet(model, parent), parent).not.toThrow();
    }
  });

  it("requires access facts when validating a newly written sheet", () => {
    const model = parse(FIRST_RUN);
    expect(() => validateSheet(model, "claude")).toThrow(/setup requires access facts/);
  });

  it("rejects a policy-enabled sheet missing a fact for a configured route", () => {
    const model = parse(sheetWith([FACT("codex"), FACT("claude")].join("\n")));
    expect(() => validateSheet(model, "claude")).toThrow(/no access fact for provider grok/);
  });

  it("rejects routes whose facts leave them unauthorized", () => {
    const model = parse(
      sheetWith([FACT("grok", "unknown"), FACT("codex"), FACT("claude")].join("\n"))
    );
    expect(() => validateSheet(model, "claude")).toThrow(/not authorized/);
    expect(() => validateSheet(model, "claude")).toThrow(/funding is unknown/);
  });

  it("rejects a fallback that resolves to the parent's own account", () => {
    const model = parse(
      sheetWith(FULL_FACTS, [
        ["how explorer: grok:grok-4.7@xhigh", "how explorer: codex:gpt-5.6-sol@max -> inherit-parent"],
      ])
    );
    expect(() => validateSheet(model, "codex")).toThrow(/codex account/);
    expect(() => validateSheet(model, "claude")).not.toThrow();
  });

  it("collects completeness and resolution issues together", () => {
    const thin = sheetWith(FULL_FACTS, [
      ["architect runners: codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh, claude:opus@max", "architect runners: codex:gpt-5.6-sol@max"],
    ]);
    const missing = thin.split("\n").filter((line) => !line.startsWith("hillclimb:")).join("\n");
    expect(() => validateSheet(parse(missing), "claude")).toThrow(
      /missing required role row: hillclimb[\s\S]*at least 2 seats|at least 2 seats[\s\S]*missing required role row: hillclimb/
    );
  });
});

describe("operator authorization and monotonic attempts", () => {
  it("does not authorize provider observations as spending permission", () => {
    for (const [funding, apiSpend] of [["included", "deny"], ["metered", "approved"]] as const) {
      const text = `# access: ${JSON.stringify({ provider: "devin", funding, capacity: "unknown", apiSpend, provenance: "provider" })}\nswarm workers: devin:swe-2@high\n`;
      const policy = resolveRole(parseSheet(text), "swarm workers", "codex")!;
      expect(policy.lanes[0].attempts[0].authorization).toMatchObject({ state: "blocked" });
      expect(nextAttempt(policy.lanes[0], [], new Set(), "read-only")).toMatchObject({ kind: "stop", reason: "unauthorized" });
      const confirmed = resolveRole(parseSheet(text.replace('"provenance":"provider"', '"provenance":"user"')), "swarm workers", "codex")!;
      expect(nextAttempt(confirmed.lanes[0], [], new Set(), "read-only")).toMatchObject({ kind: "launch", attemptIndex: 0 });
    }
  });

  it("never goes backward after a later attempt has run", () => {
    const text = '# access: {"provider":"grok","funding":"included","capacity":"unknown","apiSpend":"approved","provenance":"user"}\n# access: {"provider":"devin","funding":"included","capacity":"unknown","apiSpend":"deny","provenance":"user"}\nswarm workers: grok:grok-4.7@xhigh -> devin:swe-2@high\n';
    const lane = resolveRole(parseSheet(text), "swarm workers", "codex")!.lanes[0];
    expect(nextAttempt(lane, [{ attemptIndex: 1, status: "usage-exhausted", processStarted: false }], new Set(), "read-only")).toMatchObject({ kind: "stop", reason: "chain-exhausted" });
  });
});


it("round-trips explicit OpenCode descriptors without broadening other providers", () => {
  const sheet = FIRST_RUN.replace("grok:grok-4.7@xhigh", "opencode:provider/vendor/model@default");
  expect(renderSheet(parseSheet(sheet))).toContain("opencode:provider/vendor/model@default");
  const bedrock = "opencode:amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0@default";
  expect(renderSheet(parseSheet(FIRST_RUN.replace("grok:grok-4.7@xhigh", bedrock)))).toContain(bedrock);
  for (const invalid of ["opencode:provider/model@high", "opencode:auto@default", "opencode:provider/auto@default", "opencode:provider//model@default", "codex:provider/model@high"]) {
    expect(() => parseSheet(FIRST_RUN.replace("grok:grok-4.7@xhigh", invalid))).toThrow(ModelPolicyError);
  }
});
