import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PROVIDER_MARKS } from "./lib/provider-marks";

/**
 * Frontend entry: tinted provider marks for every agent provider this install
 * can run. The host draws them wherever it draws a provider icon (composer
 * model chip, model and provider pickers, thread header and metadata,
 * settings) and wherever a plugin renders `experimental_ProviderIcon`.
 * Disabling the plugin restores BB's `currentColor` logo masks.
 */
export default definePluginApp((app) => {
  for (const mark of PROVIDER_MARKS) {
    app.slots.experimental_providerIcon({
      providerKind: "agent",
      providerId: mark.providerId,
      icon: mark.icon,
    });
  }
});
