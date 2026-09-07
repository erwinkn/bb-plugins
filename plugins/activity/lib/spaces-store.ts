import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { spaceContract } from "./space-contract";
import { catalogSchema, type Space, type SpaceCatalog } from "./space-schema";
import { EMPTY_CATALOG, normalizeSpaces, SpaceValidationError } from "./spaces";

export const SPACES_KEY = "spaces";
export const SPACES_CHANNEL = "spaces-changed";

export class SpaceConflictError extends Error {
  constructor() {
    super("Spaces changed on another client. Reload and retry.");
  }
}

export function createSpacesStore(bb: BbPluginApi) {
  // The plugin server is one process; a promise chain makes every
  // read-modify-write atomic without a database transaction.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const read = async (): Promise<SpaceCatalog> => {
    const parsed = catalogSchema.safeParse(
      await bb.storage.kv.get<unknown>(SPACES_KEY),
    );
    return parsed.success ? parsed.data : EMPTY_CATALOG;
  };
  // `expectedRevision` null skips the check; only the CLI import uses that.
  const save = (expectedRevision: number | null, spaces: readonly Space[]) =>
    serialized(async () => {
      const current = await read();
      if (expectedRevision !== null && current.revision !== expectedRevision)
        throw new SpaceConflictError();
      const next: SpaceCatalog = {
        revision: current.revision + 1,
        spaces: normalizeSpaces(spaces),
      };
      await bb.storage.kv.set(SPACES_KEY, next);
      // The payload is the document, so clients need no follow-up fetch.
      bb.realtime.publish(SPACES_CHANNEL, next);
      return next;
    });
  return { read, save };
}

export function registerSpaces(bb: BbPluginApi) {
  const store = createSpacesStore(bb);
  bb.rpc.register(spaceContract, {
    getSpaces: () => store.read(),
    saveSpaces: ({ expectedRevision, spaces }) =>
      store.save(expectedRevision, spaces),
  });
  bb.cli.register({
    name: "activity",
    summary: "Threads sidebar spaces: named project selections shared by all clients",
    commands: [
      {
        name: "spaces-export",
        summary: "Print the space catalog as JSON",
        usage: "bb activity spaces-export",
      },
      {
        name: "spaces-import",
        summary: "Replace the space catalog with a JSON document",
        usage: "bb activity spaces-import '<json from spaces-export>'",
      },
    ],
    async run(argv) {
      const [action, payload] = argv;
      if (action !== "spaces-export" && action !== "spaces-import")
        return {
          exitCode: 2,
          stderr:
            "Usage: bb activity spaces-export | bb activity spaces-import '<json>'\n",
        };
      if (action === "spaces-export")
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(await store.read(), null, 2)}\n`,
        };
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload ?? "");
      } catch {
        return { exitCode: 2, stderr: "Import expects one JSON argument.\n" };
      }
      const document = catalogSchema.safeParse(parsed);
      const spaces = document.success
        ? document.data.spaces
        : (parsed as { spaces?: unknown })?.spaces;
      const list = catalogSchema.shape.spaces.safeParse(spaces);
      if (!list.success)
        return { exitCode: 2, stderr: "Import expects a spaces catalog.\n" };
      try {
        const next = await store.save(null, list.data);
        return {
          exitCode: 0,
          stdout: `Imported ${next.spaces.length} space(s) at revision ${next.revision}.\n`,
        };
      } catch (error) {
        if (error instanceof SpaceValidationError)
          return { exitCode: 1, stderr: `${error.message}\n` };
        throw error;
      }
    },
  });
}
