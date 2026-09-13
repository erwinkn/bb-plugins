import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createBundledHighlighter } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { GRAMMAR_IDS, GRAMMAR_REVISION, GRAMMARS, grammarRoute } from "./grammars";
import { GRAMMAR_SOURCES } from "./grammar-sources";
import { wrapForBlockNote } from "./highlighter";

test("every grammar id has a server source and every source is reachable from a key", () => {
  for (const id of GRAMMAR_IDS) assert.ok(GRAMMAR_SOURCES[id] !== undefined, `${id} has no source`);
  for (const id of Object.keys(GRAMMAR_SOURCES)) assert.ok(GRAMMAR_IDS.includes(id), `${id} is served but no key reaches it`);
  assert.equal(grammarRoute("typescript"), `/grammars/${GRAMMAR_REVISION}/typescript.json`);
});

test("the grammar revision names the installed @shikijs/langs version", () => {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "node_modules", "@shikijs", "langs", "package.json"), "utf8")) as { version: string };
  assert.equal(GRAMMAR_REVISION, `shiki-langs-${manifest.version}`);
});

test("grammar files are plain JSON with the grammar's name and scope", async () => {
  for (const id of GRAMMAR_IDS) {
    const grammars = (await GRAMMAR_SOURCES[id]!()).default;
    const copy = JSON.parse(JSON.stringify(grammars)) as typeof grammars;
    assert.equal(copy.length, grammars.length, id);
    // The Dockerfile grammar is named `docker` and lists `dockerfile` as an alias.
    assert.ok(copy.some((grammar) => grammar.name === id || grammar.aliases?.includes(id)), `${id}: no grammar named or aliased ${id}`);
    for (const grammar of copy) assert.match(grammar.scopeName, /^[a-z]/, id);
  }
});

test("after loading a key Shiki reports that key as loaded, so BlockNote never re-fetches it", async () => {
  // The same wiring as highlighter.ts, with the server's loaders instead of fetch.
  const create = createBundledHighlighter<string, string>({
    langs: Object.fromEntries(Object.entries(GRAMMARS).map(([key, id]) => [key, GRAMMAR_SOURCES[id]!])),
    themes: {},
    engine: () => createJavaScriptRegexEngine({ forgiving: true }),
  });
  const raw = await create({ themes: [{ name: "bbsp-test", type: "light", fg: "#111111", bg: "#ffffff", settings: [] }], langs: [] });
  await raw.loadTheme({ name: "bbsp-other", type: "dark", fg: "#eeeeee", bg: "#000000", settings: [] });
  const highlighter = wrapForBlockNote(raw, () => "bbsp-other");
  assert.deepEqual(highlighter.getLoadedThemes(), ["bbsp-other", "bbsp-test"]);
  for (const key of Object.keys(GRAMMARS)) {
    await highlighter.loadLanguage(key);
    assert.ok(highlighter.getLoadedLanguages().includes(key), `${key} is not reported as loaded after loading it`);
  }
  // A name outside the catalogue rejects (never throws) so BlockNote records it as one to skip.
  assert.throws(() => raw.loadLanguage("kotlin"), /not included in this bundle/);
  await assert.rejects(highlighter.loadLanguage("kotlin"), /not included in this bundle/);
  const tokens = highlighter.codeToTokens("echo hi", { lang: "sh", theme: "bbsp-test" }).tokens[0]!;
  assert.equal(tokens.map((token) => token.content).join(""), "echo hi");
});
