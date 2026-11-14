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
