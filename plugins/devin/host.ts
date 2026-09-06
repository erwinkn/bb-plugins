import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { withDevinModels } from "./model-bridge";
import { withDevinUsage } from "./usage-bridge";

export const experimental_providerBridge = withDevinUsage(withDevinModels(experimental_acpProviderBridge));
