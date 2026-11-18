import { describe, expect, it } from "vitest";
import { accountRejection, normalizedRejection } from "./account-rejection.js";

const TERMS =
  "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.";
const anthropic = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message } });

describe("accountRejection", () => {
  it("names the terms to accept, as the Equisafe gateway answered on 2026-11-14", () => {
    expect(
      accountRejection(400, anthropic("invalid_request_error", TERMS)),
    ).toBe(TERMS);
  });

  it.each([
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    "This organization has been disabled.",
    "Your API key has been revoked.",
    "You exceeded your current quota, please check your plan and billing details.",
    "Invalid API key",
  ])("names a refusal about the account: %s", (message) => {
    expect(
      accountRejection(400, anthropic("invalid_request_error", message)),
    ).toBe(message);
  });

  it("goes by the error type or a 402 whatever the message, and reads plain text and other shapes", () => {
    expect(accountRejection(400, anthropic("billing_error", "Nope."))).toBe(
      "Nope.",
    );
    expect(accountRejection(400, anthropic("authentication_error", "x"))).toBe(
      "x",
    );
    expect(accountRejection(402, "Payment required")).toBe("Payment required");
    expect(accountRejection(401, "")).toBe("HTTP 401");
    expect(accountRejection(400, JSON.stringify({ error: TERMS }))).toBe(TERMS);
    expect(accountRejection(400, TERMS)).toBe(TERMS);
  });

  it.each([
    "unknown provider for model claude-fable-5-2",
    "no such model",
    "bad request",
    "max_tokens: field required",
    "messages.0.content: Input should be a valid list",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "Invalid model name",
    'messages.0.content: unexpected field "payment"',
    "tools.0.name: billing_lookup is not a valid tool name",
    'tools.1.input_schema: property "terms" must accept a string',
    "model claude-credits-test is not supported",
    "metadata.account_id: value is invalid",
    "",
  ])("leaves a request-level refusal alone: %j", (message) => {
    expect(
      accountRejection(400, anthropic("invalid_request_error", message)),
    ).toBeNull();
  });

  describe("OpenAI's shapes", () => {
    const openai = (code: string | null, message: string, type = "invalid_request_error") =>
      JSON.stringify({ error: { message, type, param: null, code } });

    it.each([
      [401, openai("invalid_api_key", "Incorrect API key provided: sk-…abcd.")],
      [401, openai("account_deactivated", "This key is associated with a deactivated account.")],
      [400, openai("billing_not_active", "Your account is not active, please check your billing details on our website.")],
      [429, openai("insufficient_quota", "You exceeded your current quota, please check your plan and billing details.", "insufficient_quota")],
      [429, openai("billing_hard_limit_reached", "Billing hard limit has been reached.")],
      [429, JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 3600 } })],
    ])("names a refusal about the account: HTTP %i %s", (status, body) => {
      expect(accountRejection(status, body)).toBe(JSON.parse(body).error.message);
    });

    it("names an account the message calls deactivated or not active, whatever the code", () => {
      expect(accountRejection(400, openai(null, "This key is associated with a deactivated account."))).not.toBeNull();
      expect(accountRejection(403, openai(null, "Your organization is not active."))).not.toBeNull();
    });

    it("leaves a 429 rate limit alone, whatever its message says", () => {
      expect(
        accountRejection(429, openai("rate_limit_exceeded", "Rate limit reached for gpt-6.1-sol in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000.", "requests")),
      ).toBeNull();
      // A phrase that would name the account in a 400 does not in a 429: only a quota code does.
      expect(accountRejection(429, openai(null, "You exceeded your current quota for requests per minute."))).toBeNull();
      expect(accountRejection(429, "")).toBeNull();
      // Anthropic's own 429, which Claude API-key accounts now pass through here too.
      expect(accountRejection(429, '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}')).toBeNull();
    });

    it.each([
      openai("model_not_found", "unknown provider for model gpt-9-nova"),
      openai("invalid_encrypted_content", "The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed."),
      openai("context_length_exceeded", "Your input exceeds the context window of this model."),
      openai(null, "Invalid value for 'reasoning.effort': 'extreme' is not one of 'low', 'medium', 'high'."),
    ])("leaves a request-level refusal alone: %s", (body) => {
      expect(accountRejection(400, body)).toBeNull();
    });
  });

  it("only reads 4xx", () => {
    expect(accountRejection(500, TERMS)).toBeNull();
    expect(accountRejection(302, TERMS)).toBeNull();
  });
});

describe("normalizedRejection", () => {
  it("makes one message of the same refusal told with other ids, numbers, case or spacing", () => {
    expect(
      normalizedRejection(
        "Request req_011CUabcdefgh failed:  credit   balance 0",
      ),
    ).toBe(
      normalizedRejection(
        "request REQ_011CUzyxwvuts failed: Credit balance 12",
      ),
    );
    expect(normalizedRejection(TERMS)).not.toBe(
      normalizedRejection("This organization has been disabled."),
    );
  });
});
