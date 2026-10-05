// Review routes = model + transport (T76/A154 §4, A161, A168). Models are code
// constants: a response naming any other model is an error, never an alias.
// Adding a model means a code change with a verified id.

export const ROUTE_IDS = ["fake", "sonnet:pool", "sonnet:anthropic-api", "luna:pool", "luna:openai-api", "jev:typesafe"] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export type Billing = "none" | "usd" | "subscription";
export type Wire = "fake" | "anthropic-messages" | "openai-responses" | "openai-responses-sse" | "typesafe-systemone";

export const SONNET_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const SONNET_THINKING = ["adaptive", "between_tools"] as const;
export const LUNA_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

export interface RouteSpec {
  id: RouteId;
  label: string;
  model: string | null;
  wire: Wire;
  transport: "local" | "account-pool" | "direct-key";
  billing: Billing;
  categories: readonly string[];
  /** The secret setting this route needs, if any. */
  secret: "anthropicApiKey" | "openaiApiKey" | "typesafeApiKey" | null;
  /** Unverified live conditions shown next to the route; never treated as checked. */
  unverified: readonly string[];
}

const ALL = ["test-integrity", "unsupported-claim", "missed-requirement"] as const;

export const ROUTES: Record<RouteId, RouteSpec> = {
  fake: {
    id: "fake",
    label: "Fake reviewer (deterministic test double, no model)",
    model: null,
    wire: "fake",
    transport: "local",
    billing: "none",
    categories: ALL,
    secret: null,
    unverified: [],
  },
  "sonnet:pool": {
    id: "sonnet:pool",
    label: "Claude Sonnet 5.5 via Account Pooler (subscription)",
    model: "claude-sonnet-5-5",
    wire: "anthropic-messages",
    transport: "account-pool",
    billing: "subscription",
    categories: ALL,
    secret: null,
    unverified: [
      "U1: whether Anthropic accepts a non-Claude-Code request on subscription OAuth",
      "Needs the Pooler's isolated advisor route with its Claude switch on",
    ],
  },
  "sonnet:anthropic-api": {
    id: "sonnet:anthropic-api",
    label: "Claude Sonnet 5.5 via Anthropic API key (USD)",
    model: "claude-sonnet-5-5",
    wire: "anthropic-messages",
    transport: "direct-key",
    billing: "usd",
    categories: ALL,
    secret: "anthropicApiKey",
    unverified: [],
  },
  "luna:pool": {
    id: "luna:pool",
    label: "GPT-6 Luna via Account Pooler (subscription)",
    model: "gpt-6-luna",
    wire: "openai-responses-sse",
    transport: "account-pool",
    billing: "subscription",
    categories: ALL,
    secret: null,
    unverified: [
      "U2: whether the Codex backend serves gpt-6-luna to this client, and reports model and usage",
      "Needs the Pooler's isolated advisor route with its Codex switch on",
    ],
  },
  "luna:openai-api": {
    id: "luna:openai-api",
    label: "GPT-6 Luna via OpenAI API key (USD)",
    model: "gpt-6-luna",
    wire: "openai-responses",
    transport: "direct-key",
    billing: "usd",
    categories: ALL,
    secret: "openaiApiKey",
    unverified: [],
  },
  "jev:typesafe": {
    id: "jev:typesafe",
    label: "Jev 1.13.0 via TypeSafe API key (USD, test integrity only)",
    model: "jev-1.13.0",
    wire: "typesafe-systemone",
    transport: "direct-key",
    billing: "usd",
    categories: ["test-integrity"],
    secret: "typesafeApiKey",
    unverified: ["U3: TypeSafe access, token count of a JSON state, per-request billing"],
  },
};

export const POOLER_PLUGIN_ID = "account-pool-local";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const OPENAI_URL = "https://api.openai.com/v1/responses";
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
