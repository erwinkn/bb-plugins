import type { Store } from "./store";
/** Retain identity through a native event that archives/removes membership. */
export const scopedNativeEvent = (store: Pick<Store, "membership">, changed: (projectId?: string) => void) =>
  <T extends { thread?: { id: string }; entry?: { threadId: string } }>(work: (data: T) => void | Promise<void>) =>
  async (data: T) => {
    const threadId = data.thread?.id ?? data.entry?.threadId;
    const before = threadId ? store.membership(threadId, true) : null;
    await work(data);
    const member = (threadId ? store.membership(threadId, true) : null) ?? before;
    if (member) changed(member.project.id);
    else if (!threadId) changed();
  };
