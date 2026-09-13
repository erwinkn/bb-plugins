import { describe, expect, it } from "vitest";
import { parseGithubRemote, parsePullRequestReference, parsePullRequestUrl, pullRequestUrl } from "./pull-request-url";

describe("parsePullRequestUrl", () => {
  it("accepts pull request URLs with trailing paths, queries, and hashes", () => {
    for (const url of [
      "https://github.com/acme/widgets/pull/7",
      "https://github.com/acme/widgets/pull/7/files",
      "http://www.github.com/acme/widgets/pull/7?diff=split#discussion_r1",
      "  https://github.com/acme/widgets/pull/7/ ",
    ]) {
      expect(parsePullRequestUrl(url)).toEqual({ repo: "acme/widgets", number: 7 });
    }
  });

  it("rejects everything that is not a github.com pull request", () => {
    for (const url of [
      "https://github.com/acme/widgets/issues/7",
      "https://github.com/acme/widgets/pulls",
      "https://github.com/acme/widgets/pull/abc",
      "https://gitlab.com/acme/widgets/-/merge_requests/7",
      "https://github.com/acme/widgets/pull/0",
      "https://evil.github.com.example/acme/widgets/pull/7",
      "not a url",
    ]) {
      expect(parsePullRequestUrl(url)).toBeNull();
    }
  });

  it("round-trips the canonical URL", () => {
    expect(pullRequestUrl({ repo: "acme/widgets", number: 7 })).toBe("https://github.com/acme/widgets/pull/7");
  });
});

describe("parsePullRequestReference", () => {
  it("accepts URLs, qualified refs, and bare numbers with a default repo", () => {
    expect(parsePullRequestReference("https://github.com/a/b/pull/3", null)).toEqual({ ref: { repo: "a/b", number: 3 } });
    expect(parsePullRequestReference("a/b#3", null)).toEqual({ ref: { repo: "a/b", number: 3 } });
    expect(parsePullRequestReference("#3", "a/b")).toEqual({ ref: { repo: "a/b", number: 3 } });
    expect(parsePullRequestReference("3", "a/b")).toEqual({ ref: { repo: "a/b", number: 3 } });
  });

  it("explains what is missing", () => {
    expect(parsePullRequestReference("#3", null)).toEqual({ error: expect.stringContaining("needs a repository") });
    expect(parsePullRequestReference("https://github.com/a/b/issues/3", null)).toEqual({ error: expect.stringContaining("not a github.com pull request URL") });
    expect(parsePullRequestReference("", null)).toEqual({ error: expect.stringContaining("Pass a pull request") });
    expect(parsePullRequestReference("nonsense", "a/b")).toEqual({ error: expect.stringContaining("not a pull request URL") });
  });
});

describe("parseGithubRemote", () => {
  it("reads https, ssh, and git remotes", () => {
    expect(parseGithubRemote("https://github.com/acme/widgets.git\n")).toBe("acme/widgets");
    expect(parseGithubRemote("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(parseGithubRemote("ssh://git@github.com/acme/widgets")).toBe("acme/widgets");
    expect(parseGithubRemote("https://gitlab.com/acme/widgets.git")).toBeNull();
  });
});
