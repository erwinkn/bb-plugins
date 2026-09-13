import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { withDevinModels } from "./model-bridge";
import { withDevinUsage } from "./usage-bridge";
import { withDevinWriteShim } from "./write-shim";

export const experimental_providerBridge = withDevinUsage(withDevinModels(withDevinWriteShim(experimental_acpProviderBridge)));
