import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { AntigravityService } from "./src/agy.js";
import { withAntigravityUsage } from "./src/bridge.js";

export const experimental_providerBridge = withAntigravityUsage(
  experimental_acpProviderBridge,
  new AntigravityService(),
);
