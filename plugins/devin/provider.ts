import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { ROLE_TINTS } from "./role-tints";

// Keep the ID used by the previous custom ACP entry and saved thread references.
export const PROVIDER_ID = "acp-devin";

export function devinProvider(command: string): PluginProviderDeclaration {
  return {
    id: PROVIDER_ID,
    displayName: "Devin",
    family: "acp",
    icon: "./assets/devin.svg",
    strings: {
      signInHint: "Run `devin auth login` on the machine to sign in.",
      expiredHint: "Your Devin CLI session expired. Run `devin auth login`, then reload.",
      installUrl: "https://docs.devin.ai/work-with-devin/devin-cli",
      // Agent purple (the theme plugin's `--bbp-agent` pair); BB accepts
      // literal colors only here and renders them with light-dark().
      iconTint: { light: ROLE_TINTS.agent.light, dark: ROLE_TINTS.agent.dark },
    },
    experimental_bridgeOptions: {
      acpDialect: "generic",
      acpLaunchSpec: { displayName: "Devin", command, args: ["acp"], env: {} },
    },
    models: { scope: "host" },
    maintenance: { health: true, usage: true, installation: false },
    // The live model catalog supplies each model group's exact effort choices.
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }],
    composerActions: [],
  };
}
