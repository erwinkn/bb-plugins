import { describe, expect, it } from "vitest";
import { appContract } from "../src/contract.js";

describe("RPC inputs", () => {
  // `bb plugin rpc call` sends null when it is given no input.
  it("read-only methods accept null, an empty object, and (for usage) force", () => {
    for (const input of [null, {}]) {
      expect(appContract.status.input.safeParse(input).success).toBe(true);
      expect(appContract.usage.input.safeParse(input).success).toBe(true);
    }
    expect(appContract.usage.input.safeParse({ force: true }).success).toBe(true);
  });

  it("still rejects stray fields and wrong types", () => {
    expect(appContract.usage.input.safeParse({ force: "yes" }).success).toBe(false);
    expect(appContract.usage.input.safeParse({ other: 1 }).success).toBe(false);
    expect(appContract.status.input.safeParse({ other: 1 }).success).toBe(false);
  });
});
