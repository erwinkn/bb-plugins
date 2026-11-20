import type { BbPluginApi, PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { AntigravityService } from "./src/agy.js";
import { appContract, PROVIDER_ID } from "./src/contract.js";

export const ANTIGRAVITY_LAUNCH_SPEC = {
  displayName: "Antigravity",
  command: "agy",
  args: ["acp"],
  env: { AGY_ACP_FORCE_FILE_STORAGE: "1" },
  permissionCli: { full: ["--dangerously-skip-permissions"], insertAfterArgs: 1 },
  nativeSkillRoots: {
    user: [".gemini/config/skills", ".gemini/antigravity-cli/skills"],
    project: [".gemini/skills", ".agents/skills", ".agent/skills"],
  },
};

export const ANTIGRAVITY_PROVIDER: PluginProviderDeclaration = {
  id: PROVIDER_ID,
  displayName: "Antigravity",
  family: "acp",
  icon: "./icons/antigravity.svg",
  strings: {
    signInHint: "Sign in to Antigravity from Settings → Antigravity, then reload.",
    expiredHint: "Your Antigravity sign-in expired. Sign in again from Settings → Antigravity.",
    installUrl: "https://antigravity.google/docs/getting-started",
    iconTint: { light: "#3186FF", dark: "#6FA8FF" },
  },
  serviceTiers: [
    { id: "default", label: "Default" },
    { id: "fast", label: "Fast" },
  ],
  experimental_visibility: "installed",
  experimental_nativeSkillRoots: {
    user: [...ANTIGRAVITY_LAUNCH_SPEC.nativeSkillRoots.user],
    project: [...ANTIGRAVITY_LAUNCH_SPEC.nativeSkillRoots.project],
  },
  experimental_bridgeOptions: {
    acpDialect: "generic",
    acpLaunchSpec: ANTIGRAVITY_LAUNCH_SPEC,
  },
  models: { scope: "host" },
  maintenance: { health: true, usage: false, installation: false },
  capabilities: {
    supportsServiceTier: true,
    supportsNativeUserQuestion: false,
    supportsManualCompaction: false,
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
    permissionModes: ["accept-edits", "full"],
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  composerActions: [],
};

export default function antigravityPlugin(bb: BbPluginApi): void {
  const registered = bb.providers.register(ANTIGRAVITY_PROVIDER);
  const service = new AntigravityService();
  bb.onDispose(() => {
    service.dispose();
    registered.dispose();
  });

  bb.rpc.register(appContract, {
    status: () => service.status(),
    usage: (input) => service.usage(input?.force === true),
    signInStart: () => service.signInStart(),
    signInSubmit: ({ flowId, response }) => service.signInSubmit(flowId, response),
    signInCancel: ({ flowId }) => service.signInCancel(flowId),
    signOut: () => service.signOut(),
  });
}
