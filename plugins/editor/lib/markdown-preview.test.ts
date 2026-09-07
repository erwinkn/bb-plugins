import assert from "node:assert/strict";
import { test } from "node:test";
import { hasMarkdownImage, rewriteMarkdownPaths, workspacePathFromHref, workspaceRoot } from "./markdown-preview.js";

const at = { filePath: "docs/guide/intro.md", baseUrl: "/preview/abc" };

test("relative images resolve against the document's directory", () => {
  assert.equal(rewriteMarkdownPaths("![Logo](./img/logo.png)", at), "![Logo](/preview/abc/docs/guide/img/logo.png)");
  assert.equal(
    rewriteMarkdownPaths('![a](../assets/a%20b.png "Title")', at),
    '![a](/preview/abc/docs/assets/a%20b.png "Title")',
  );
  assert.equal(rewriteMarkdownPaths("![x](<my img.png>)", at), "![x](/preview/abc/docs/guide/my%20img.png)");
});

test("relative links become root-relative so BB resolves them from the workspace root", () => {
  assert.equal(rewriteMarkdownPaths("[setup](./setup.md)", at), "[setup](docs/guide/setup.md)");
  assert.equal(rewriteMarkdownPaths("[api](../api.md#section)", at), "[api](docs/api.md)");
  assert.equal(rewriteMarkdownPaths("[log](CHANGELOG.md)", { filePath: "README.md", baseUrl: null }), "[log](CHANGELOG.md)");
  assert.equal(rewriteMarkdownPaths("[s](<my doc.md>)", at), "[s](<docs/guide/my doc.md>)");
});

test("without a lease, images stay as written while links still resolve", () => {
  const source = "![a](x.png) [b](y.md)";
  assert.equal(rewriteMarkdownPaths(source, { ...at, baseUrl: null }), "![a](x.png) [b](docs/guide/y.md)");
});

test("absolute, remote, anchor and escaping paths are left alone", () => {
  for (const source of [
    "![a](https://example.com/a.png)",
    "[a](https://example.com)",
    "![a](/absolute.png)",
    "![a](data:image/png;base64,AAAA)",
    "[a](#section)",
    "[a](mailto:x@y.z)",
    "![a](../../../outside.png)",
    "![a](//cdn/x.png)",
  ]) {
    assert.equal(rewriteMarkdownPaths(source, at), source);
  }
});

test("paths inside fenced code stay as written", () => {
  const source = "```md\n![a](x.png)\n```\n![b](y.png)\n~~~\n[c](z.md)\n~~~";
  assert.equal(
    rewriteMarkdownPaths(source, at),
    "```md\n![a](x.png)\n```\n![b](/preview/abc/docs/guide/y.png)\n~~~\n[c](z.md)\n~~~",
  );
});

test("a document at the root resolves paths from the root", () => {
  assert.equal(rewriteMarkdownPaths("![a](shot.png)", { filePath: "README.md", baseUrl: "/p" }), "![a](/p/shot.png)");
});

test("only documents with an image ask for a lease", () => {
  assert.equal(hasMarkdownImage("# Title\n\n[a link](x.md)"), false);
  assert.equal(hasMarkdownImage("![shot](x.png)"), true);
});

test("file links BB rendered under the root map back to workspace paths", () => {
  assert.equal(workspacePathFromHref("file:///work/space/docs/a%20b.md", "/work/space"), "docs/a b.md");
  assert.equal(workspacePathFromHref("file:///work/space/docs/a.md", "/work/space/"), "docs/a.md");
  for (const href of ["file:///work/other/a.md", "file:///work/space", "file:///work/space/", "https://example.com", "#x", "file:///work/spaced/a.md"]) {
    assert.equal(workspacePathFromHref(href, "/work/space"), null, href);
  }
});

test("the workspace root is the absolute path without its root-relative tail", () => {
  assert.equal(workspaceRoot("/repo/docs/guide.md", "docs/guide.md"), "/repo");
  assert.equal(workspaceRoot("C:\\repo\\docs\\guide.md", "docs\\guide.md"), "C:\\repo");
  assert.equal(workspaceRoot("/repo/docs/guide.md", ""), "");
  assert.equal(workspaceRoot("/elsewhere/guide.md", "docs/guide.md"), "");
});
