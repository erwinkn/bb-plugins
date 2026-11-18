import { describe, expect, it } from "vitest";
import { callerToken, parseCallerToken } from "./caller-token.js";

const HOST_TOKEN = "oFZPaS31LeuT-kUrvVCNaQfDJUj0PjTp7dDOEBcM7rk";

describe("a hub token naming the caller's project", () => {
  it("round-trips a BB project id", () => {
    const token = callerToken(HOST_TOKEN, "proj_thpyarb96b");
    expect(token).toBe(`${HOST_TOKEN};project=proj_thpyarb96b`);
    expect(parseCallerToken(token)).toEqual({ hostToken: HOST_TOKEN, projectId: "proj_thpyarb96b" });
  });

  it("reads a bare host token as naming no project", () => {
    expect(parseCallerToken(HOST_TOKEN)).toEqual({ hostToken: HOST_TOKEN, projectId: null });
  });

  it("keeps an id it cannot carry out of the token", () => {
    expect(callerToken(HOST_TOKEN, "")).toBe(HOST_TOKEN);
    expect(callerToken(HOST_TOKEN, "a;project=b")).toBe(HOST_TOKEN);
    expect(callerToken(HOST_TOKEN, "x".repeat(129))).toBe(HOST_TOKEN);
  });

  it("leaves a malformed project in the host token, which then fails to authenticate", () => {
    for (const presented of [`${HOST_TOKEN};project=`, `${HOST_TOKEN};project=a b`, `${HOST_TOKEN};project=a;project=b`])
      expect(parseCallerToken(presented)).toEqual({ hostToken: presented, projectId: null });
  });
});
