import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { withDevinModels } from "./model-bridge";
import { withDevinUsage } from "./usage-bridge";
import { withDevinRowTints } from "./row-tints";
import { withDevinWriteShim } from "./write-shim";

export const experimental_providerBridge = withDevinRowTints(withDevinUsage(withDevinModels(withDevinWriteShim(experimental_acpProviderBridge))));
