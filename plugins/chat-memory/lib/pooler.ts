import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { POOLER_PLUGIN_ID, responsesSummarizer } from "./summarizer";

/**
 * Luna through the Account Pooler's isolated plugin route, with the Pooler's plugin token (held
 * for one call, never stored or logged). It needs the Pooler's codex advisor route on
 * (`bb pool-local advisor set codex on`); until then calls answer 403 and the builder waits.
 */
export const poolerSummarizer = (bb: BbPluginApi) =>
  responsesSummarizer({
    fetch: (...args) => fetch(...args),
    url: () => `${bb.server.loopbackBaseUrl}/api/v1/plugins/${POOLER_PLUGIN_ID}/http/advisor/v1/responses`,
    headers: async () => ({ "x-bb-plugin-token": (await bb.sdk.plugins.token({ pluginId: POOLER_PLUGIN_ID })).token }),
  });
