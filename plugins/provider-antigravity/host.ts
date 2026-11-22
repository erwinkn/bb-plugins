import { acpProviderBridge } from "../../lib/acp-bridge/src/index.js";
import { AntigravityService } from "./src/agy.js";
import { withAntigravityUsage } from "./src/bridge.js";

// The shared ACP bridge of this repository (lib/acp-bridge): BB's ACP kit plus OptChat turns.
export const experimental_providerBridge = withAntigravityUsage(
  acpProviderBridge,
  new AntigravityService(),
);
