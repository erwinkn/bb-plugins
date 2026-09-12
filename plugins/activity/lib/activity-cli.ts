import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { createLibraryStore } from "./library-store";
import { runLibraryCli } from "./library-store";
import type { createSpacesStore } from "./spaces-store";
import { runSpacesCli } from "./spaces-store";

// `bb.cli.register` accepts one registration per plugin, so every store's
// subcommands dispatch through here.
export function registerActivityCli(
  bb: BbPluginApi,
  stores: {
    spaces: ReturnType<typeof createSpacesStore>;
    library: ReturnType<typeof createLibraryStore>;
  },
) {
  bb.cli.register({
    name: "activity",
    summary:
      "Threads sidebar spaces and saved-thread library, shared by all clients",
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
      {
        name: "library-export",
        summary: "Print the saved-thread library as JSON",
        usage: "bb activity library-export",
      },
      {
        name: "library-import",
        summary: "Replace the saved-thread library with a JSON document",
        usage: "bb activity library-import '<json from library-export>'",
      },
    ],
    async run(argv) {
      const [action, payload] = argv;
      return (
        (await runSpacesCli(stores.spaces, action, payload)) ??
        (await runLibraryCli(stores.library, action, payload)) ?? {
          exitCode: 2,
          stderr:
            "Usage: bb activity spaces-export | bb activity spaces-import '<json>' | bb activity library-export | bb activity library-import '<json>'\n",
        }
      );
    },
  });
}
