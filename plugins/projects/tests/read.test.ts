import { expect, it } from "vitest";
import { memoryStore, brief } from "./helpers";
import { readCollection, readOptionsSchema } from "../lib/read";
it("returns bounded summaries and retrieves a requested brief without repeating all tasks", () => {
  const { db, store } = memoryStore();
  store.createProject({
    id: "p",
    name: "Search",
    objective: "Find history",
    memberProjectIds: ["proj_a"],
    coordinatorThreadId: null,
  });
  for (let i = 0; i < 25; i++)
    store.createTask({
      projectId: "p",
      title: `Task ${i}`,
      summary: "Useful work",
      brief: brief(),
      priority: 2,
      dependsOn: [],
      workKind: "implementation",
      profileOverride: null,
      profileSource: null,
    });
  const page = readCollection(store, "p", "tasks", readOptionsSchema.parse({}));
  expect(page.items).toHaveLength(20);
  expect(page.nextOffset).toBe(20);
  expect(page.items[0]).not.toHaveProperty("brief");
  const detail = readCollection(
    store,
    "p",
    "tasks",
    readOptionsSchema.parse({ refs: ["T12"], detailed: true }),
  );
  expect(detail.items).toHaveLength(1);
  expect(detail.items[0]).toHaveProperty("brief");
  db.close();
});
