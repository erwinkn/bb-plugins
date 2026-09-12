import test from "node:test";
import assert from "node:assert/strict";
import { CLIENT_STATE_EVENT, CLIENT_STATE_KEY, LIBRARY_SCOPE_ID, SPACES_CACHE_KEY, applySpace, currentSpace, readSelectedSpaceId, readSpaces, resolveSpace } from "./spaces-bridge.ts";
import { readFileSync } from "node:fs";

/** The activity plugin's exported constants, read as text so this test needs none of its dependencies. */
function activityConstant(file: string, name: string): string {
  const source = readFileSync(new URL(`../activity/lib/${file}`, import.meta.url), "utf8");
  return new RegExp(`export const ${name} = "([^"]+)"`).exec(source)?.[1] ?? "";
}
const ACTIVITY_CACHE = activityConstant("use-spaces.ts", "SPACES_CACHE_KEY"), ACTIVITY_STATE = activityConstant("client-state.ts", "CLIENT_STATE_KEY"), ACTIVITY_EVENT = activityConstant("client-state.ts", "CLIENT_STATE_EVENT"), ACTIVITY_LIBRARY = activityConstant("spaces.ts", "LIBRARY_SCOPE_ID");

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const spaces = [{ id: "s1", name: "Mobile", projectIds: ["a", "b"] }, { id: "s2", name: "BB plugins", projectIds: ["c"] }, { id: "s3", name: "Client work", projectIds: [] }];

test("the storage keys and event match the activity plugin's contract", () => {
  assert.equal(SPACES_CACHE_KEY, ACTIVITY_CACHE); assert.equal(CLIENT_STATE_KEY, ACTIVITY_STATE); assert.equal(CLIENT_STATE_EVENT, ACTIVITY_EVENT);
  assert.equal(LIBRARY_SCOPE_ID, ACTIVITY_LIBRARY);
});

test("spaces come from the cached catalog and the selection from client state", () => {
  const storage = memory();
  assert.deepEqual(readSpaces(storage), []);
  assert.deepEqual(currentSpace(storage), { id: null, name: "All projects", projectCount: null });
  storage.setItem(SPACES_CACHE_KEY, JSON.stringify({ revision: 3, spaces }));
  storage.setItem(CLIENT_STATE_KEY, JSON.stringify({ groupBy: "status", spaceId: "s2" }));
  assert.equal(readSpaces(storage).length, 3);
  assert.deepEqual(currentSpace(storage), { id: "s2", name: "BB plugins", projectCount: 1 });
  storage.setItem(SPACES_CACHE_KEY, "not json");
  assert.deepEqual(readSpaces(storage), []);
});

test("a spoken name resolves by ranked matching, and 'all projects' clears the space", () => {
  assert.equal(resolveSpace("the mobile space", spaces).choice?.id, "s1");
  assert.equal(resolveSpace("BB plugin", spaces).choice?.id, "s2");
  assert.equal(resolveSpace("clients", spaces).choice?.id, "s3");
  assert.deepEqual(resolveSpace("all projects", spaces).choice, { id: null, name: "All projects", projectCount: null });
  assert.deepEqual(resolveSpace("everything", spaces).choice, { id: null, name: "All projects", projectCount: null });
  const miss = resolveSpace("finance", spaces);
  assert.equal(miss.choice, null); assert.equal(miss.candidates.length, 3, "the caller can say what exists");
});

test("the library scope resolves by its spoken names and reports as the current scope", () => {
  const library = { id: LIBRARY_SCOPE_ID, name: "Library", projectCount: null };
  for (const spoken of ["library", "the library", "saved", "saved threads"]) assert.deepEqual(resolveSpace(spoken, spaces).choice, library, spoken);
  const storage = memory();
  applySpace(storage, library, () => {});
  assert.equal(readSelectedSpaceId(storage), "library");
  assert.deepEqual(currentSpace(storage), library);
});

test("applying a space writes the activity plugin's state and notifies this window", () => {
  const storage = memory(); const events: string[] = [];
  storage.setItem(CLIENT_STATE_KEY, JSON.stringify({ groupBy: "project", hidden: ["done"], spaceId: "s1" }));
  applySpace(storage, { id: "s2", name: "BB plugins", projectCount: 1 }, e => events.push(e));
  assert.deepEqual(JSON.parse(storage.getItem(CLIENT_STATE_KEY)!), { groupBy: "project", hidden: ["done"], spaceId: "s2" }, "other preferences survive");
  assert.deepEqual(events, [CLIENT_STATE_EVENT]);
  applySpace(storage, { id: null, name: "All projects", projectCount: null }, e => events.push(e));
  assert.equal(JSON.parse(storage.getItem(CLIENT_STATE_KEY)!).spaceId, null);
});
