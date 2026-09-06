import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { devinProvider } from "./provider";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    command: {
      type: "string",
      label: "Devin executable",
      description: "Executable name or absolute path on the machine that runs the thread. Uses devin acp; sign in with devin auth login on that machine.",
      default: "devin",
      experimental_schema: z.string().trim().min(1),
    },
  });
  const initial = await settings.get();
  let registration = bb.providers.register(devinProvider(initial.command.trim()));
  settings.onChange((next) => {
    registration.dispose();
    registration = bb.providers.register(devinProvider(next.command.trim()));
  });
  bb.onDispose(() => registration.dispose());
}
