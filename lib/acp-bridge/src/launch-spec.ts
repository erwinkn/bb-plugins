/**
 * The launch spec a provider plugin sends in `options.providerOptions.acpLaunchSpec`. The SDK
 * ships upstream's schema (`@bb/provider-bridge-acp/launch-spec`) as the host daemon's copy.
 */
export {
  acpLaunchSpecSchema,
  normalizeAcpLaunchSpec,
  type AcpLaunchSpec,
} from "./bb.js";
