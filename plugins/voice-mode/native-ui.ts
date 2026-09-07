// Native BB UI controller for Voice. One window-local singleton that drives
// bb's own workspace through Plugin SDK hooks bound from React surfaces:
// the app overlay (route context, navigation, sidebar thread actions) and
// each mounted composer (draft editing scoped to exactly one thread or the
// new-thread screen). Voice tools call `execute`; the caller re-checks call
// ownership through `isCurrent` and this executor re-checks it before every
// step so a command from another device or a hung-up call never moves this
// window. It never navigates on its own: every action here is one the user
// asked for by voice, and a draft is only ever prepared, never sent.
import type {
  BbNavigate,
  ComposerView,
  ExperimentalFileOpenOptions,
  PluginComposerApi,
  PluginComposerScope,
  PluginSidebarThreadActions,
} from "@get-bb/plugin-sdk/app";
import type { UiAction, UiActionResult } from "./ui-actions.ts";

/** Live app-level bindings from the global overlay (one per bb window). */
export interface NativeUiAppBinding {
  kind: "app";
  /** Current route selection; read live, never cached. */
  context: () => { threadId: string | null; projectId: string | null };
  /** Current pathname, used to confirm the Voice panel opened. */
  route: () => string;
  navigate: Pick<BbNavigate, "toProject" | "toPluginPanel">;
  threads: Pick<PluginSidebarThreadActions, "open" | "openNewThread">;
}

/**
 * File preview is a surface capability in bb: the app overlay's navigate hook
 * always declines, while a page or composer surface supplies the real handler.
 * Surfaces that can preview lend it here.
 */
export type NativeUiPreview = (options: ExperimentalFileOpenOptions) => boolean;

/**
 * One mounted composer; several exist at once in a split layout. The scope is
 * read live through `view()` on every use: React can reuse one component
 * instance for another composer scope before a passive effect re-runs, so a
 * captured scope could point at the wrong target.
 */
export interface NativeUiComposerBinding {
  kind: "composer";
  /** Reactive read side (scope, draft, run); read live at execution time. */
  view: () => Pick<ComposerView, "scope" | "draft" | "run">;
  composer: Pick<PluginComposerApi, "setText" | "updateText">;
  openFilePreview: NativeUiPreview;
}

/** The mounted, visible Voice panel; lets show_voice select the live conversation. */
export interface NativeUiVoicePanelBinding {
  kind: "voice-panel";
  /**
   * Select the conversation view of `conversationId` (the current call's when
   * null). Returns true once the conversation is on screen, false when it is
   * not available here (no such session, no current call).
   */
  showConversation: (conversationId: string | null) => boolean;
  openFilePreview: NativeUiPreview;
}

export type NativeUiBinding = NativeUiAppBinding | NativeUiComposerBinding | NativeUiVoicePanelBinding;

/** What the voice side knows about this window's UI, read live. */
export interface UiSnapshot {
  /** Thread selected by the route, or null. */
  threadId: string | null;
  /** Project selected by the route (or by the new-thread composer), or null. */
  projectId: string | null;
  /** True when the root New thread composer is on screen and no thread is. */
  onNewThreadScreen: boolean;
  /** Current pathname, "" when no app surface is bound. */
  route: string;
  /** Composer scopes mounted right now (split panes show several). */
  composers: readonly PluginComposerScope[];
  /** Draft of the composer matching the route thread / new-thread screen. */
  draft: { scope: PluginComposerScope; text: string; isRunning: boolean } | null;
  /** False before the app overlay mounts (tests, teardown). */
  bound: boolean;
}

/** Bound wait for a route or composer to appear after a navigation request. */
const READY_TIMEOUT_MS = 6000;
const POLL_MS = 100;

/** The Voice nav panel path (`app.slots.navPanel` in app.tsx) under this plugin id. */
export const VOICE_PANEL_PATH = "sessions";
const VOICE_ROUTE_PREFIX = `/plugins/voice-mode/${VOICE_PANEL_PATH}`;
/** Panel sub-path that means "select the current call's conversation view". */
export const VOICE_CONVERSATION_SUBPATH = "conversation";

const succeeded = (detail: string): UiActionResult => ({ status: "succeeded", detail });
const failed = (detail: string): UiActionResult => ({ status: "failed", detail });
const cancelled = (detail: string): UiActionResult => ({ status: "cancelled", detail });
const unknown = (detail: string): UiActionResult => ({ status: "unknown", detail });

export class NativeUi {
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;
  constructor(options: { readyTimeoutMs?: number; pollMs?: number } = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? POLL_MS;
  }
  private app: NativeUiAppBinding | null = null;
  private composers = new Map<symbol, NativeUiComposerBinding>();
  private voicePanels = new Map<symbol, NativeUiVoicePanelBinding>();
  private listeners = new Set<() => void>();
  private connected = true;

  /** Register a surface; the returned disposer must run on unmount. */
  bind(binding: NativeUiBinding): () => void {
    if (binding.kind === "app") {
      this.app = binding;
      this.notify();
      return () => {
        // React runs the old cleanup before the new setup, so a stale
        // disposer must not clear a newer overlay's binding.
        if (this.app === binding) this.app = null;
        this.notify();
      };
    }
    const key = Symbol();
    const registry: Map<symbol, NativeUiBinding> = binding.kind === "composer" ? this.composers : this.voicePanels;
    registry.set(key, binding);
    this.notify();
    return () => {
      registry.delete(key);
      this.notify();
    };
  }

  /** Tell waiters that live state behind a binding changed (a route render). */
  refresh() { this.notify(); }

  /**
   * Realtime transport state from the app. While disconnected, a cancellation
   * from the server could be lost, so no action starts and any action waiting
   * on a route or composer stops (cancelled) rather than landing later.
   */
  setTransportConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.notify();
  }
  transportConnected(): boolean { return this.connected; }

  /** Observe binding changes (route rebinds, composers mounting/unmounting). */
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private notify() {
    for (const listener of this.listeners) listener();
  }

  readonly snapshot = (): UiSnapshot => {
    const app = this.app;
    const context = app?.context() ?? { threadId: null, projectId: null };
    const views = [...this.composers.values()].map(c => c.view());
    const newThread = views.find(v => v.scope.kind === "new-thread");
    const onNewThreadScreen = context.threadId === null && !!newThread;
    const view = context.threadId !== null
      ? views.find(v => v.scope.kind === "thread" && v.scope.threadId === context.threadId) ?? null
      : newThread ?? null;
    return {
      threadId: context.threadId,
      projectId: context.projectId ?? (onNewThreadScreen && newThread?.scope.kind === "new-thread" ? newThread.scope.projectId : null),
      onNewThreadScreen,
      route: app?.route() ?? "",
      composers: views.map(v => v.scope),
      draft: view ? { scope: view.scope, text: view.draft.text, isRunning: view.run.isRunning } : null,
      bound: app !== null,
    };
  };

  /**
   * Run one UI action in this window. `isCurrent` must stay true for the whole
   * action (same call, this window owns it); it is re-checked before every step
   * and while waiting, and a false answer cancels without any further UI change.
   */
  async execute(action: UiAction, isCurrent: () => boolean): Promise<UiActionResult> {
    if (!isCurrent()) return cancelled("This window no longer owns the call.");
    if (!this.connected) return cancelled("The connection to bb is down; the command will be re-read when it returns.");
    const app = this.app;
    if (!app) return failed("No bb window is bound to Voice right now.");
    try {
      switch (action.kind) {
        case "open_thread": return await this.openThread(app, action.threadId, action.split, isCurrent);
        case "open_project": return await this.openProject(app, action.projectId, isCurrent);
        case "prepare_draft": return await this.prepareDraft(app, action, isCurrent);
        case "preview_file": return this.previewFile(app, action);
        case "show_voice": return await this.showVoice(app, isCurrent);
      }
    } catch (cause) {
      return failed(cause instanceof Error ? cause.message : String(cause));
    }
    return failed("Unsupported UI action.");
  }

  private findComposer(match: (scope: PluginComposerScope) => boolean): NativeUiComposerBinding | null {
    return [...this.composers.values()].find(c => match(c.view().scope)) ?? null;
  }

  private threadComposer(threadId: string): NativeUiComposerBinding | null {
    return this.findComposer(scope => scope.kind === "thread" && scope.threadId === threadId);
  }

  /** A protected editing surface on this thread (queued-message editor, side chat). */
  private threadEditing(threadId: string): PluginComposerScope | null {
    return this.findComposer(scope =>
      (scope.kind === "queued-message" && scope.threadId === threadId) ||
      (scope.kind === "side-chat" && (scope.parentThreadId === threadId || scope.childThreadId === threadId)),
    )?.view().scope ?? null;
  }

  private newThreadComposer(): NativeUiComposerBinding | null {
    return this.findComposer(scope => scope.kind === "new-thread");
  }

  /** The exact scope a draft action may write into. */
  private static draftScopeMatches(scope: PluginComposerScope, target: Extract<UiAction, { kind: "prepare_draft" }>["target"]): boolean {
    if (target.kind === "thread") return scope.kind === "thread" && scope.threadId === target.threadId;
    return scope.kind === "new-thread" && (!target.projectId || scope.projectId === target.projectId);
  }

  private threadShown(app: NativeUiAppBinding, threadId: string): boolean {
    return app.context().threadId === threadId || this.threadComposer(threadId) !== null;
  }

  private async openThread(app: NativeUiAppBinding, threadId: string, split: boolean, isCurrent: () => boolean): Promise<UiActionResult> {
    const before = app.context().threadId;
    const alreadyShown = this.threadShown(app, threadId);
    // Always go through bb: it applies its own split rules (right split by
    // default, focus when the thread is already open in a pane, plain
    // navigation on compact viewports or when splits are off).
    app.threads.open(threadId, { split });
    if (alreadyShown) {
      return succeeded(before === threadId
        ? `Thread ${threadId} is already the current thread.`
        : `Thread ${threadId} was already open; bb focused it.`);
    }
    const ready = await this.waitFor(() => this.threadShown(app, threadId), isCurrent, () => {
      const now = app.context().threadId;
      return now !== before && now !== threadId && now !== null;
    });
    if (ready === "cancelled") return cancelled(`Stopped opening thread ${threadId}: the call moved on.`);
    if (ready === "aborted") return cancelled(`Stopped opening thread ${threadId}: you went somewhere else.`);
    if (ready === "timeout") return unknown(`Asked bb to open thread ${threadId}, but it has not appeared. It may not exist.`);
    const after = app.context().threadId;
    if (split && before !== null && before !== threadId && after === before && this.threadComposer(threadId)) {
      return succeeded(`Thread ${threadId} is open in a split beside the current thread.`);
    }
    if (split) return succeeded(`Thread ${threadId} is open. bb did not confirm a split; on a small screen or with splits off it replaces the view.`);
    return succeeded(`Thread ${threadId} is now the current thread.`);
  }

  private async openProject(app: NativeUiAppBinding, projectId: string, isCurrent: () => boolean): Promise<UiActionResult> {
    const before = app.context();
    if (before.projectId === projectId && before.threadId === null) return succeeded(`Project ${projectId} is already open.`);
    app.navigate.toProject(projectId);
    const ready = await this.waitFor(() => {
      const now = app.context();
      return now.projectId === projectId && now.threadId === null;
    }, isCurrent, () => {
      const now = app.context();
      return now.projectId !== null && now.projectId !== before.projectId && now.projectId !== projectId;
    });
    if (ready === "cancelled") return cancelled(`Stopped opening project ${projectId}: the call moved on.`);
    if (ready === "aborted") return cancelled(`Stopped opening project ${projectId}: you went somewhere else.`);
    if (ready === "timeout") return unknown(`Asked bb to open project ${projectId}, but the route has not changed. It may not exist.`);
    return succeeded(`Project ${projectId} is open.`);
  }

  private async prepareDraft(
    app: NativeUiAppBinding,
    action: Extract<UiAction, { kind: "prepare_draft" }>,
    isCurrent: () => boolean,
  ): Promise<UiActionResult> {
    const { target, mode } = action;
    const text = action.text;
    if (!text.trim()) return failed("There is no text to put in the draft.");
    let binding: NativeUiComposerBinding | null;
    let label: string;
    if (target.kind === "thread") {
      label = `thread ${target.threadId}`;
      binding = this.threadComposer(target.threadId);
      if (!binding) {
        const protectedScope = this.threadEditing(target.threadId);
        if (protectedScope) {
          return failed(protectedScope.kind === "queued-message"
            ? `A queued message is being edited in ${label}. Finish that edit first.`
            : `A side chat is open on ${label}. Close it first to draft in the thread itself.`);
        }
        // The user asked to draft into this thread, so bring it on screen (plain
        // navigation, never a background pane), then wait for its composer.
        const before = app.context().threadId;
        app.threads.open(target.threadId);
        const ready = await this.waitFor(() => this.threadComposer(target.threadId) !== null, isCurrent, () => {
          const now = app.context().threadId;
          return now !== before && now !== target.threadId && now !== null;
        });
        if (ready === "cancelled") return cancelled(`Stopped drafting in ${label}: the call moved on.`);
        if (ready === "aborted") return cancelled(`Stopped drafting in ${label}: you went somewhere else.`);
        if (ready === "timeout") return failed(`Could not reach the composer of ${label} in time. Ask me to try again.`);
        binding = this.threadComposer(target.threadId);
      }
    } else {
      label = target.projectId ? `a new thread in project ${target.projectId}` : "a new thread";
      binding = this.matchingNewThread(target.projectId);
      if (!binding) {
        if (this.newThreadComposer() && !target.projectId) binding = this.newThreadComposer();
      }
      if (!binding) {
        const before = app.context().threadId;
        app.threads.openNewThread({ ...(target.projectId ? { projectId: target.projectId } : {}), focusPrompt: false });
        // The route changes asynchronously: the starting thread stays current
        // for a moment, so only a different thread counts as going elsewhere.
        const ready = await this.waitFor(() => this.matchingNewThread(target.projectId) !== null, isCurrent, () => {
          const now = app.context().threadId;
          return now !== null && now !== before;
        });
        if (ready === "cancelled") return cancelled(`Stopped drafting ${label}: the call moved on.`);
        if (ready === "aborted") return cancelled(`Stopped drafting ${label}: you opened a thread instead.`);
        if (ready === "timeout") return failed(`Could not reach the new-thread composer for ${label}.`);
        binding = this.matchingNewThread(target.projectId);
      }
    }
    if (!binding) return failed(`No composer is available for ${label}.`);
    if (!isCurrent() || !this.connected) return cancelled(`Stopped drafting in ${label}: the call moved on.`);
    // Re-read the live scope right before writing: the composer instance may
    // have been handed to another scope since it was matched.
    const view = binding.view();
    if (!NativeUi.draftScopeMatches(view.scope, target)) return failed(`The composer of ${label} changed before the draft was written. Nothing was changed.`);
    if (view.run.isSubmitting) return failed(`The composer of ${label} is sending right now. Try again in a moment.`);
    const existing = view.draft.text;
    if (mode === "replace") {
      binding.composer.setText(text);
      return succeeded(existing ? `Replaced the draft in ${label}. It is not sent.` : `Prepared a draft in ${label}. It is not sent.`);
    }
    binding.composer.updateText(current => (current ? `${current}\n${text}` : text));
    return succeeded(existing ? `Appended to the existing draft in ${label}. It is not sent.` : `Prepared a draft in ${label}. It is not sent.`);
  }

  private matchingNewThread(projectId: string | undefined): NativeUiComposerBinding | null {
    return this.findComposer(scope => scope.kind === "new-thread" && (!projectId || scope.projectId === projectId));
  }

  /** The surface whose preview handler applies to what the user is looking at. */
  private previewSurface(app: NativeUiAppBinding): { name: string; openFilePreview: NativeUiPreview } | null {
    const { threadId } = app.context();
    const composer = threadId !== null
      ? this.threadComposer(threadId)
      : this.newThreadComposer();
    if (composer) return { name: threadId !== null ? `thread ${threadId}` : "the New thread screen", openFilePreview: composer.openFilePreview };
    const panel = this.voicePanel();
    if (panel) return { name: "the Voice page", openFilePreview: panel.openFilePreview };
    return null;
  }

  private previewFile(app: NativeUiAppBinding, action: Extract<UiAction, { kind: "preview_file" }>): UiActionResult {
    const surface = this.previewSurface(app);
    if (!surface) return failed(`This screen has no file preview panel, so ${action.target.path} cannot be shown from the current screen.`);
    const accepted = surface.openFilePreview({ target: action.target, location: action.location ?? null });
    const where = action.location
      ? action.location.kind === "line" ? ` at line ${action.location.line}` : ` at lines ${action.location.startLine}-${action.location.endLine}`
      : "";
    return accepted
      ? succeeded(`bb accepted the request to preview ${action.target.path}${where} from ${surface.name}. It opens in the preview panel.`)
      : failed(`bb declined to preview ${action.target.path} from ${surface.name}. The file target may be invalid or unavailable there.`);
  }

  private voicePanel(): NativeUiVoicePanelBinding | null {
    return [...this.voicePanels.values()].at(-1) ?? null;
  }

  /**
   * Show the current call's conversation view. A mounted Voice panel selects it
   * directly (also from the session list or a debug tab); otherwise navigate to
   * the panel with the `conversation` sub-path and wait for it to mount, then
   * ask it. Success means the panel confirmed the selection, not just the URL.
   */
  private async showVoice(app: NativeUiAppBinding, isCurrent: () => boolean): Promise<UiActionResult> {
    const startThread = app.context().threadId;
    const mounted = this.voicePanel();
    if (mounted) {
      return mounted.showConversation(null)
        ? succeeded("The Voice conversation is on screen.")
        : failed("The Voice page is open, but there is no current conversation to show.");
    }
    app.navigate.toPluginPanel(VOICE_PANEL_PATH, { subPath: VOICE_CONVERSATION_SUBPATH });
    const ready = await this.waitFor(() => this.voicePanel() !== null, isCurrent, () =>
      // The user left for a route that is neither Voice nor where we started.
      !app.route().startsWith(VOICE_ROUTE_PREFIX) && app.context().threadId !== null && app.context().threadId !== startThread,
    );
    if (ready === "cancelled") return cancelled("Stopped opening Voice: the call moved on.");
    if (ready === "aborted") return cancelled("Stopped opening Voice: you went somewhere else.");
    if (ready === "timeout") return unknown("Asked bb to open the Voice page, but it did not mount in time.");
    // The wait resolved on a binding change; the call may have moved on in the
    // same tick, so guard again right before touching the panel.
    if (!isCurrent() || !this.connected) return cancelled("Stopped opening Voice: the call moved on.");
    const panel = this.voicePanel();
    return panel?.showConversation(null)
      ? succeeded("The Voice conversation is on screen.")
      : failed("The Voice page opened, but there is no current conversation to show.");
  }

  /**
   * Resolve "ready" when `predicate` holds, "cancelled" when `isCurrent` turns
   * false, "aborted" when `abort` holds (the user went elsewhere), or "timeout".
   * Checks run on every binding change plus a short poll (route changes that
   * rebind nothing, e.g. between two routes with no selection).
   */
  private waitFor(
    predicate: () => boolean,
    isCurrent: () => boolean,
    abort: () => boolean = () => false,
    timeoutMs = this.readyTimeoutMs,
  ): Promise<"ready" | "cancelled" | "aborted" | "timeout"> {
    return new Promise(resolve => {
      let done = false;
      const finish = (result: "ready" | "cancelled" | "aborted" | "timeout") => {
        if (done) return;
        done = true;
        unsubscribe();
        clearInterval(poll);
        clearTimeout(timer);
        resolve(result);
      };
      const check = () => {
        if (!isCurrent() || !this.connected) finish("cancelled");
        else if (predicate()) finish("ready");
        else if (abort()) finish("aborted");
      };
      const unsubscribe = this.subscribe(check);
      const poll = setInterval(check, this.pollMs);
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      check();
    });
  }
}

export const nativeUi = new NativeUi();
