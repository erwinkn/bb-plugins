import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { withDevinUsage } from "./usage-bridge";

export const experimental_providerBridge = withDevinUsage(experimental_acpProviderBridge);
