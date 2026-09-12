import { describe, expect, it } from "vitest";
import {
  MAX_FAVORITES,
  isFavorite,
  resolveReasoningLevel,
  toggleFavorite,
  type FavoriteModel,
  type ReasoningLevel,
} from "./favorites.js";

const base: FavoriteModel = {
  providerId: "codex",
  model: "gpt-5.5",
  modelName: "GPT-5.5",
  providerName: "Codex",
  reasoningLevel: null,
  createdAt: 1,
};

describe("toggleFavorite", () => {
  it("adds then removes the same provider/model pair", () => {
    const added = toggleFavorite([], base);
    expect(added.starred).toBe(true);
    expect(added.favorites).toHaveLength(1);
    expect(isFavorite(added.favorites, "codex", "gpt-5.5")).toBe(true);

    const removed = toggleFavorite(added.favorites, base);
    expect(removed.starred).toBe(false);
    expect(removed.favorites).toHaveLength(0);
  });

  it("treats the same model on another provider as a different favorite", () => {
    const other = { ...base, providerId: "claude-code" };
    const { favorites } = toggleFavorite([base], other);
    expect(favorites).toHaveLength(2);
  });

  it("refuses to grow past the cap", () => {
    const full = Array.from({ length: MAX_FAVORITES }, (_, index) => ({
      ...base,
      model: `m${index}`,
    }));
    expect(() => toggleFavorite(full, { ...base, model: "extra" })).toThrow(
      /limit/i,
    );
  });
});

describe("resolveReasoningLevel", () => {
  const entry: {
    defaultReasoningEffort: ReasoningLevel;
    reasoningEfforts: ReasoningLevel[];
  } = {
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high"],
  };

  it("prefers the requested level when the model supports it", () => {
    expect(resolveReasoningLevel(entry, "high", "low")).toBe("high");
  });

  it("keeps the current level when the request is unsupported", () => {
    expect(resolveReasoningLevel(entry, "ultra", "low")).toBe("low");
  });

  it("falls back to the model default", () => {
    expect(resolveReasoningLevel(entry, null, "ultra")).toBe("medium");
  });

  it("uses the default when the catalog lists no efforts", () => {
    expect(
      resolveReasoningLevel(
        { defaultReasoningEffort: "none", reasoningEfforts: [] },
        "high",
        "low",
      ),
    ).toBe("none");
  });
});
