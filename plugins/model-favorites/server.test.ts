import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "./server.js";

const CATALOG_MODEL = {
  id: "gpt-5.5",
  model: "gpt-5.5",
  displayName: "GPT-5.5",
  description: "",
  isDefault: true,
  defaultReasoningEffort: "medium" as const,
  supportedReasoningEfforts: [
    { reasoningEffort: "low" as const, description: "" },
    { reasoningEffort: "medium" as const, description: "" },
    { reasoningEffort: "high" as const, description: "" },
  ],
};

const PROVIDER = {
  id: "codex",
  pluginId: "bb-core",
  displayName: "Codex",
  available: true,
  logoUrl: null,
  composerActions: [],
  capabilities: {
    modelCatalogScope: "host" as const,
    permissionModes: ["auto" as const],
    supportsFork: true,
    supportsNativeUserQuestion: false,
    supportsServiceTier: false,
    supportsSessionRewind: false,
    supportsThreadArchive: true,
    supportsThreadRename: true,
  },
  maintenance: { health: true, installation: true, usage: false },
};

function makeHost() {
  const updates: { threadId: string; model?: string | null; reasoningLevel?: string | null }[] = [];
  const host = createFakePluginHost({
    pluginId: "erwin-model-favorites",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            providerId: "codex",
            environmentId: "env_1",
          }),
        defaultExecutionOptions: async () => ({
          model: "gpt-5.5",
          reasoningLevel: "medium" as const,
          permissionMode: "auto" as const,
          serviceTier: "default" as const,
          source: "client/turn/requested" as const,
        }),
        update: async (args: {
          threadId: string;
          model?: string | null;
          reasoningLevel?: string | null;
        }) => {
          updates.push(args);
          return makeThreadResponse({ id: args.threadId });
        },
      },
      providers: {
        list: async () => [PROVIDER],
        models: async () => ({
          modelLoadError: null,
          models: [CATALOG_MODEL],
          permissionCeiling: "full" as const,
          providers: [PROVIDER],
          selectedOnlyModels: [],
        }),
      },
    },
  });
  return { ...host, updates };
}

describe("model favorites backend", () => {
  it("stars, lists, and unstars a model with catalog names resolved", async () => {
    const { bb, harness } = makeHost();
    plugin(bb);

    const added = rpcContract.favorites_toggle.output.parse(
      await harness.behavior.callRpc("favorites_toggle", {
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "high",
      }),
    );
    expect(added.starred).toBe(true);
    expect(added.favorites).toHaveLength(1);
    expect(added.favorites[0]).toMatchObject({
      providerName: "Codex",
      modelName: "GPT-5.5",
      reasoningLevel: "high",
    });

    const removed = rpcContract.favorites_toggle.output.parse(
      await harness.behavior.callRpc("favorites_toggle", {
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: null,
      }),
    );
    expect(removed.starred).toBe(false);
    expect(removed.favorites).toHaveLength(0);
  });

  it("applies a catalog model with the thread's reasoning when valid", async () => {
    const { bb, harness, updates } = makeHost();
    plugin(bb);

    const applied = rpcContract.apply_model.output.parse(
      await harness.behavior.callRpc("apply_model", {
        threadId: "thr_1",
        model: "gpt-5.5",
        reasoningLevel: "high",
      }),
    );
    expect(applied).toMatchObject({
      model: "gpt-5.5",
      modelName: "GPT-5.5",
      reasoningLevel: "high",
    });
    expect(updates).toEqual([
      { threadId: "thr_1", model: "gpt-5.5", reasoningLevel: "high" },
    ]);
  });

  it("rejects a model that is not in the thread's provider catalog", async () => {
    const { bb, harness } = makeHost();
    plugin(bb);

    await expect(
      harness.behavior.callRpc("apply_model", {
        threadId: "thr_1",
        model: "claude-opus-4.5",
      }),
    ).rejects.toThrow(/not in this thread's provider catalog/);
  });

  it("reports the thread's provider and current model", async () => {
    const { bb, harness } = makeHost();
    plugin(bb);

    const context = rpcContract.thread_context.output.parse(
      await harness.behavior.callRpc("thread_context", {
        threadId: "thr_1",
      }),
    );
    expect(context.providerId).toBe("codex");
    expect(context.providerName).toBe("Codex");
    expect(context.current).toMatchObject({
      model: "gpt-5.5",
      reasoningLevel: "medium",
    });
    expect(context.models).toHaveLength(1);
  });
});
