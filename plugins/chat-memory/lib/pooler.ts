import { readFile } from "node:fs/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { POOLER_PLUGIN_ID, fallbackSummarizer, responsesSummarizer } from "./summarizer";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/**
 * The OPENAI_API_KEY line of a dotenv file, read at each call so a key added or changed needs no
 * reload. A missing file or line throws (no fallback configured); the error never holds the key.
 */
export async function openaiKey(file: string): Promise<string> {
  const text = await readFile(file, "utf8").catch(() => "");
  const key = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^"'\s#]+)/mu.exec(text)?.[1];
  if (!key) throw new Error(`no OPENAI_API_KEY in ${file}`);
  return key;
}

/**
 * Luna through the Account Pooler's isolated plugin route, with the Pooler's plugin token (held
 * for one call, never stored or logged). It needs the Pooler's codex advisor route on
 * (`bb pool-local advisor set codex on`); until then calls answer 403. W587: while that route is
 * rate-limited or unavailable, the same request goes to OpenAI's API on the key in `keyFile`
 * (pay-as-you-go, outside the Pooler's usage report); without a key, the builder waits as before.
 */
export const poolerSummarizer = (bb: BbPluginApi, keyFile: string) => {
  const fetcher: typeof fetch = (...args) => fetch(...args);
  return fallbackSummarizer(
    responsesSummarizer({
      fetch: fetcher,
      url: () => `${bb.server.loopbackBaseUrl}/api/v1/plugins/${POOLER_PLUGIN_ID}/http/advisor/v1/responses`,
      headers: async () => ({ "x-bb-plugin-token": (await bb.sdk.plugins.token({ pluginId: POOLER_PLUGIN_ID })).token }),
    }),
    responsesSummarizer({ fetch: fetcher, url: () => OPENAI_RESPONSES_URL, headers: async () => ({ authorization: `Bearer ${await openaiKey(keyFile)}` }), direct: true }),
    { log: (message) => bb.log.warn(message) },
  );
};
