import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MUSE_EXECUTABLE_ENV, MUSE_FALLBACK_MODELS, MUSE_PROVIDER_ID } from "./src/vocabulary.js";

export default function plugin(bb: BbPluginApi): void {
  const registered = bb.providers.register({
    id: MUSE_PROVIDER_ID,
    displayName: "Muse",
    icon: "./icons/muse.svg",
    strings: {
      signInHint: "Run `muse login` on the machine to sign in.",
      expiredHint: "Your Muse session expired. Run `muse login` on the machine, then reload.",
      installUrl: "https://github.com/meta-models/muse-code-sdk",
      brandPrefix: "Muse ",
      iconTint: { light: "#0064E0", dark: "#4DA3FF" },
    },
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "none",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    composerActions: [],
    // Muse's catalog comes from the account, not the workspace.
    models: { fallback: MUSE_FALLBACK_MODELS, scope: "host" },
    env: { passthrough: [MUSE_EXECUTABLE_ENV] },
  });
  bb.onDispose(() => registered.dispose());
}
