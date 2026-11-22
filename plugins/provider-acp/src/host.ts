import os from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { probeAcpAgent } from "../../../lib/acp-bridge/src/index.js";
import { acpHostContract } from "./contract.js";
import { resolveAcpNativeRoots } from "./native-roots/index.js";

// The shared ACP bridge of this repository (lib/acp-bridge): BB's ACP kit plus OptChat turns.
export { acpProviderBridge as experimental_providerBridge } from "../../../lib/acp-bridge/src/index.js";

export default experimental_defineHostEntry({
  contract: acpHostContract,
  handlers: {
    probeAgent: async (input, context) =>
      probeAcpAgent({
        command: input.command,
        args: input.args,
        env: input.env,
        cwd: context.experimental_paths.tempDir,
      }),
    resolveNativeRoots: (input) =>
      resolveAcpNativeRoots({
        agentId: input.providerId,
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
  },
});
