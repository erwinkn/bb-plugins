import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { projectContract } from "./project-contract";
import type { ManagedProject, ProjectInventory } from "./project-schema";

type Sdk = BbPluginApi["sdk"];
type ProjectRecord = Awaited<ReturnType<Sdk["projects"]["get"]>>;
type HostRecord = Awaited<ReturnType<Sdk["hosts"]["list"]>>[number];

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

function toHost(host: HostRecord) {
  return {
    id: host.id,
    name: host.name,
    connected: host.status === "connected",
  };
}

// Project management goes through BB's own API, so the native new-thread
// panel and this sidebar always agree. BB pushes the resulting sidebar
// changes to every client itself.
export function registerProjects(bb: BbPluginApi) {
  const { projects, hosts } = bb.sdk;
  const inventory = async (): Promise<ProjectInventory> => {
    const [list, hostList] = await Promise.all([
      projects.list({ includePersonal: true }),
      hosts.list(),
    ]);
    return { projects: list.map(toManaged), hosts: hostList.map(toHost) };
  };
  const defaultSource = async (projectId: string) => {
    const project = await projects.get({ projectId });
    const source = toManaged(project).source;
    if (!source) throw new Error("This project has no folder to change.");
    return source;
  };
  bb.rpc.register(projectContract, {
    listProjects: inventory,
    createProject: async ({ name, hostId, path }) =>
      toManaged(
        await projects.create({
          name,
          source: { type: "local_path", hostId, path },
        }),
      ),
    renameProject: async ({ projectId, name }) =>
      toManaged(await projects.update({ projectId, name })),
    deleteProject: async ({ projectId }) => {
      await projects.delete({ projectId });
      return { ok: true as const };
    },
    reorderProject: async ({ projectId, previousProjectId, nextProjectId }) => {
      await projects.reorder({ projectId, previousProjectId, nextProjectId });
      return inventory();
    },
    changeProjectFolder: async ({ projectId, path }) => {
      const source = await defaultSource(projectId);
      await projects.sources.update({
        projectId,
        sourceId: source.id,
        type: "local_path",
        path,
      });
      return toManaged(await projects.get({ projectId }));
    },
    listDirectory: async ({ hostId, path }) => {
      const listing = await hosts.directory({ hostId, path });
      return {
        directory: listing.directory,
        parent: listing.parent,
        entries: listing.entries
          .filter((entry) => entry.kind === "directory")
          .map(({ name, path }) => ({ name, path })),
      };
    },
    // Plugin frontends do not know the client's host, so the dialog opens on
    // the machine that will hold the project. That is the client's machine
    // in a single-host setup; remote hosts use the path field instead.
    pickFolder: async ({ hostId }) => {
      const { path } = await hosts.pickFolder({ hostId, clientHostId: hostId });
      return { path };
    },
  });
}
