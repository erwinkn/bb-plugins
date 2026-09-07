// A window-local collection of views. Host panels present this collection;
// voice and UI controls use the same operations. Never broadcast navigation.
export type ThreadView = {
  kind: "thread";
  id: string;
  threadId: string;
  projectId: string | null;
  title: string;
};
// Extend this union when another supported first-party renderer is available.
export type WorkspaceView = ThreadView;
export interface WorkspaceSnapshot {
  views: readonly WorkspaceView[];
  activeId: string | null;
}
type Presenter = { reveal: () => boolean; available: () => boolean };

export class ViewWorkspace {
  private value: WorkspaceSnapshot = { views: [], activeId: null };
  private listeners = new Set<() => void>();
  private presenters = new Map<symbol, Presenter>();
  private visiblePanels = new Map<symbol, () => boolean>();
  readonly get = () => this.value;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(value: WorkspaceSnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  registerPresenter(presenter: Presenter) {
    const key = Symbol();
    this.presenters.set(key, presenter);
    return () => { this.presenters.delete(key); };
  }
  registerVisiblePanel(visible: () => boolean) {
    const key = Symbol();
    this.visiblePanels.set(key, visible);
    return () => { this.visiblePanels.delete(key); };
  }
  /** Only a mounted, visible panel can supply conversational context. */
  current(): WorkspaceView | null {
    if (![...this.visiblePanels.values()].some(visible => visible())) return null;
    return this.value.views.find(view => view.id === this.value.activeId) ?? null;
  }
  open(views: readonly WorkspaceView[]) {
    if (!views.length) throw new Error("No threads were selected.");
    const presenter = [...this.presenters.values()].reverse().find(p => p.available());
    if (!presenter) throw new Error("Open the Voice area to inspect threads. The call is still running.");
    const next = [...this.value.views];
    for (const view of views) {
      const existing = next.findIndex(item => item.id === view.id);
      if (existing >= 0) next[existing] = view;
      else next.push(view);
    }
    // Reveal first; a rejected/throwing host must leave the collection intact.
    if (!presenter.reveal()) throw new Error("The Voice area could not show the thread. The call is still running.");
    this.set({ views: next, activeId: views[0].id });
  }
  select(id: string) {
    if (this.value.views.some(view => view.id === id)) this.set({ ...this.value, activeId: id });
  }
  close(id: string) {
    const index = this.value.views.findIndex(view => view.id === id);
    if (index < 0) return;
    const views = this.value.views.filter(view => view.id !== id);
    const activeId = this.value.activeId === id
      ? views[Math.min(index, views.length - 1)]?.id ?? null
      : this.value.activeId;
    this.set({ views, activeId });
  }
  clear() { this.set({ views: [], activeId: null }); }
}

export const viewWorkspace = new ViewWorkspace();
