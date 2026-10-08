import { describe, expect, it } from "vitest";
import { providerUsageTone, type UsageProvider } from "./usage-schema.js";

function provider(
  id: string,
  displayName: string,
  usedPercent: number,
): UsageProvider {
  return {
    id,
    displayName,
    logoUrl: null,
    iconGlyph: null,
    iconTint: null,
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    usage: {
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: [
        {
          label: "Five-hour limit",
          usedPercent,
          resetsAt: null,
          cost: null,
        },
      ],
    },
  };
}

describe("usage warning state", () => {
  it("distinguishes normal, warning, and critical usage", () => {
    const low = provider("codex", "Codex", 79);
    const warning = provider("codex", "Codex", 80);
    const critical = provider("codex", "Codex", 95);

    expect(providerUsageTone(low, null)).toBeNull();
    expect(providerUsageTone(warning, null)).toBe("warning");
    expect(providerUsageTone(critical, null)).toBe("critical");
  });
});

describe("pooled warning state", () => {
  const pooled = (status: "ready" | "exhausted" | "disabled", active: boolean, usedPercent: number) => ({
    id: status + active + usedPercent,
    name: "account",
    status,
    active,
    availableAt: null,
    error: null,
    windows: [{ label: "5h", usedPercent, resetsAt: null, cost: null }],
  });
  const claude = provider("claude-code", "Claude Code", 100);

  it("is critical when no enabled account is ready, and otherwise follows the active account", () => {
    const pool = (accounts: ReturnType<typeof pooled>[]) => ({ providerId: "claude-code", planLabel: null, accounts });
    // The machine's own login is at 100%, but the pool is what serves requests.
    expect(providerUsageTone(claude, pool([pooled("exhausted", false, 100), pooled("ready", true, 40)]))).toBeNull();
    expect(providerUsageTone(claude, pool([pooled("ready", true, 85)]))).toBe("warning");
    expect(providerUsageTone(claude, pool([pooled("exhausted", true, 100), pooled("disabled", false, 0)]))).toBe("critical");
    expect(providerUsageTone(claude, pool([pooled("disabled", false, 0)]))).toBeNull();
  });
});
