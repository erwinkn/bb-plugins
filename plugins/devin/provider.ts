import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";

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
    },
    experimental_bridgeOptions: {
      acpDialect: "generic",
      acpLaunchSpec: { displayName: "Devin", command, args: ["acp"], env: {} },
    },
    models: { scope: "host" },
    maintenance: { health: true, usage: true, installation: false },
    // Preserve the previous generic ACP contract; the live model catalog is precise.
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
    serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }],
    composerActions: [],
  };
}
