import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { projectContract } from "./project-contract";
import type { ManagedProject } from "./project-schema";

type Sdk = BbPluginApi["sdk"];
type ProjectRecord = Awaited<ReturnType<Sdk["projects"]["get"]>>;

function toManaged(project: ProjectRecord): ManagedProject {
  const source =
    project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
  return {
    id: project.id,
    name: project.name,
    isPersonal: project.kind === "personal",
    source: source
      ? { id: source.id, hostId: source.hostId, path: source.path }
      : null,
  };
}

// Project header actions go through BB's own API, so the native new-thread
// panel and this sidebar always agree. BB pushes the resulting sidebar
// changes to every client itself.
export function registerProjects(bb: BbPluginApi) {
  const { projects } = bb.sdk;
  bb.rpc.register(projectContract, {
    renameProject: async ({ projectId, name }) =>
      toManaged(await projects.update({ projectId, name })),
    deleteProject: async ({ projectId }) => {
      await projects.delete({ projectId });
      return { ok: true as const };
    },
  });
}
