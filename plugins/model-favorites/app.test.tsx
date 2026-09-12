// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";

afterEach(cleanup);

const THREAD_CONTEXT = {
  providerId: "codex",
  providerName: "Codex",
  current: { model: "gpt-5.5", reasoningLevel: "medium" as const },
  models: [
    {
      model: "gpt-5.5",
      displayName: "GPT-5.5",
      isDefault: true,
      defaultReasoningEffort: "medium" as const,
      reasoningEfforts: ["low" as const, "medium" as const, "high" as const],
    },
    {
      model: "gpt-5.6",
      displayName: "GPT-5.6",
      isDefault: false,
      defaultReasoningEffort: "medium" as const,
      reasoningEfforts: ["low" as const, "medium" as const, "high" as const],
    },
  ],
  modelLoadError: null,
};

const FAVORITES = [
  {
    providerId: "codex",
    model: "gpt-5.6",
    modelName: "GPT-5.6",
    providerName: "Codex",
    reasoningLevel: "high" as const,
    createdAt: 1,
  },
  {
    providerId: "claude-code",
    model: "claude-opus-4.8",
    modelName: "Claude Opus 4.8",
    providerName: "Claude Code",
    reasoningLevel: null,
    createdAt: 2,
  },
];

function rpcHandlers(overrides?: {
  apply?: PluginRpcTestHandlers<typeof rpcContract>["apply_model"];
  toggle?: PluginRpcTestHandlers<typeof rpcContract>["favorites_toggle"];
}): PluginRpcTestHandlers<typeof rpcContract> {
  return {
    favorites_list: () => ({ favorites: FAVORITES }),
    favorites_toggle: (input) =>
      overrides?.toggle?.(input) ?? { favorites: FAVORITES, starred: true },
    thread_context: () => THREAD_CONTEXT,
    apply_model: (input: { threadId: string; model: string }) =>
      overrides?.apply?.(input) ?? {
        model: input.model,
        modelName: input.model,
        reasoningLevel: "high" as const,
      },
    default_selection: () => null,
  };
}

describe("favorite models composer action", () => {
  it("lists favorites first, disables other providers, applies on click", async () => {
    const calls: { model: string; reasoningLevel?: string | null }[] = [];
    const app = await loadPluginApp(() => import("./app"));
    const action = app.composerCustomizations[0]!.actions![0]!;
    renderSlot<Record<string, never>, typeof rpcContract>(action, {}, {
      composer: { scope: { kind: "thread", threadId: "thr_1" } },
      rpc: rpcHandlers({
        apply: (input) => {
          calls.push(input);
          return { model: input.model, modelName: "GPT-5.6", reasoningLevel: "high" as const };
        },
      }),
    });
    fireEvent.click(await screen.findByLabelText("Favorite models"));

    // The Claude favorite is visible but cannot be applied to a codex thread.
    const other = await screen.findByText("Claude Opus 4.8");
    expect(other.closest("[aria-disabled]")).not.toBeNull();

    // The favorite appears in both sections; the first row is the favorite.
    // Applying closes the popover, so assert the call and stop querying.
    const favoriteRow = (await screen.findAllByText("GPT-5.6"))[0]!;
    fireEvent.click(favoriteRow);
    await waitFor(() =>
      expect(calls).toEqual([
        { threadId: "thr_1", model: "gpt-5.6", reasoningLevel: "high" },
      ]),
    );
  });

  it("disables the action for a side chat with no child thread yet", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const action = app.composerCustomizations[0]!.actions![0]!;
    const slot = renderSlot<Record<string, never>, typeof rpcContract>(
      action,
      {},
      {
        composer: {
          scope: {
            kind: "side-chat",
            projectId: "p1",
            parentThreadId: "thr_parent",
            tabId: "tab1",
            childThreadId: null,
          },
        },
        rpc: rpcHandlers(),
      },
    );
    const button = await slot.findByLabelText("Favorite models");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
