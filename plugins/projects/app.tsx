import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  definePluginApp,
  Markdown,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbNavigate,
  experimental_useCodeTheme as useCodeTheme,
  experimental_NewThreadComposer as NewThreadComposer,
  type NewThreadRequest,
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { projectsContract, ProjectSummary } from "./lib/contract";
import { PROJECT_DETAILS_CONFLICT } from "./lib/project-context";
import type { Command } from "./lib/commands";
import { sharedReads } from "./lib/dashboard-data";
import { applyCommitted } from "./lib/committed-result";
import type { Overview, OpinionItem } from "./lib/overview";
import {
  DEFAULT_PROFILES,
  type Profile,
  type ProjectContext,
} from "./lib/schema";
import "./app.css";
import { ProjectsSettings } from "./settings-view";
import { AutoTextarea, ControlRoom } from "./control-room";

export const PROJECT_PANEL = "project-overview";
const describeError = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
type Api = ReturnType<typeof useRpc<typeof projectsContract>>;
const rememberNote = (id: string, note: string | null) => {
  try {
    if (note) sessionStorage.setItem(`projects:creation:${id}`, note);
  } catch {
    /* The current page still carries the note when browser storage is disabled. */
  }
};
const rememberedNote = (id: string) => {
  try {
    return sessionStorage.getItem(`projects:creation:${id}`);
  } catch {
    return null;
  }
};

/** Shared by RPC realm and key; route changes synchronously select their own data. */
function useData<T>(key: string, fetchData: () => Promise<T>, enabled = true) {
  const api = useRpc<typeof projectsContract>();
  const cache = sharedReads(api);
  const [, render] = useState(0);
  const refresh = useCallback(() => enabled ? cache.refresh(key, fetchData) : Promise.resolve(), [cache, key, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = cache.subscribe(key, () => render(n => n + 1));
    void refresh();
    return unsubscribe;
  }, [cache, key, enabled, refresh]);
  const schedule = () => cache.schedule(key, fetchData);
  useRealtime("projects-changed", payload => {
    const id = (payload as { projectId?: string } | null)?.projectId;
    if (!enabled || key === "inventory") return;
    const scoped = ["overview:", "details:", "compose:"].some(prefix => key.startsWith(prefix));
    const membershipId = (cache.entry(key).data as { projectId?: string } | null)?.projectId;
    if (!id || scoped && key.endsWith(`:${id}`) || !scoped && (!membershipId || membershipId === id)) schedule();
  });
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const connectedOnce = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected") {
      if (enabled && connectedOnce.current && previousConnection.current !== "connected") schedule();
      connectedOnce.current = true;
    }
    previousConnection.current = connection;
  }, [connection, cache, key, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => { if (document.visibilityState !== "hidden") schedule(); }, 15000);
    return () => clearInterval(interval);
  }, [cache, key, enabled]);
  const entry = cache.entry(key);
  return { data: entry.data as T | null, error: entry.error, loaded: entry.loaded, refresh,
    schedule, begin: () => cache.begin(key) };
}

function ErrorNotice({
  message,
  retry,
}: {
  message: string | null;
  retry?: () => void;
}) {
  return message ? (
    <div role="alert" className="project-error">
      {message}
      {retry && <button onClick={retry}>Retry</button>}
    </div>
  ) : null;
}
type Selection = { kind: "option"; index: number } | { kind: "other" } | null;

function Opinion({
  item,
  answer,
}: {
  item: OpinionItem;
  answer: (command: Command) => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<Selection>(null);
  const [detail, setDetail] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailRef = useRef<HTMLTextAreaElement | null>(null);
  const hasOptions = item.options.length > 0;
  const isOther = selected?.kind === "other";
  const needsText = isOther || !hasOptions;
  const canSubmit =
    !busy && (needsText ? detail.trim().length > 0 : selected !== null);

  useEffect(() => {
    if (isOther) detailRef.current?.focus();
  }, [isOther]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (selected?.kind === "option" && !item.options[selected.index]) {
      setError("The options changed. Please pick again.");
      setSelected(null);
      return;
    }
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await answer({
        action: "answer",
        decision: item.ref,
        choice:
          selected?.kind === "option"
            ? item.options[selected.index]!.label
            : null,
        note: detail,
        notify,
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="project-card project-opinion" onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault(); event.currentTarget.requestSubmit();
      } else if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) && /^[1-6]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (index < item.options.length) setSelected({ kind: "option", index });
        else if (index === item.options.length) setSelected({ kind: "other" });
      }
    }}>
      <h3>{item.title}</h3>
      <Markdown className="project-question" content={item.question} />
      {item.context ? (
        <Markdown className="project-context" content={item.context} />
      ) : null}
      {hasOptions ? (
        <div
          className="project-choices"
          role="radiogroup"
          aria-label={`Options for "${item.title}"`}
        >
          {item.options.map((o, index) => (
            <label className="project-option" key={index}>
              <input
                type="radio"
                name={item.ref}
                value={o.label}
                checked={
                  selected?.kind === "option" && selected.index === index
                }
                onChange={() => setSelected({ kind: "option", index })}
              />
              <span>
                <strong>{o.label}</strong>
                <Markdown className="project-muted" content={o.consequences} />
              </span>
            </label>
          ))}
          <label className="project-option">
            <input
              type="radio"
              name={item.ref}
              value="__other__"
              checked={isOther}
              onChange={() => setSelected({ kind: "other" })}
            />
            <span>
              <strong>Other</strong>
              <span className="project-muted">Write your own answer.</span>
            </span>
          </label>
        </div>
      ) : null}
      {item.recommendation ? (
        <div className="project-reco">
          <span className="project-reco-tag">Recommended</span>
          <Markdown content={item.recommendation} />
        </div>
      ) : null}
      {item.blocks.length > 0 ? (
        <p className="project-muted">
          Waiting for this answer:{" "}
          {item.blocks.map((t) => `${t.ref} ${t.title}`).join(", ")}
        </p>
      ) : null}
      {selected !== null || !hasOptions ? (
        <label className="project-field">
          {needsText ? "Your answer" : "Add detail (optional)"}
          <AutoTextarea
            ref={detailRef}
            rows={needsText ? 3 : 2}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={4000}
            required={needsText}
            placeholder={
              needsText
                ? "Write your answer."
                : "Optional context for this choice."
            }
          />
        </label>
      ) : null}
      <ErrorNotice message={error} />
      <label className="project-notification-option">
        <input type="checkbox" checked={notify} disabled={busy} onChange={event => setNotify(event.target.checked)} />
        <span>Notify coordinator</span>
      </label>
      <p className="project-hint">{notify ? "Your choice and note will be sent to the current coordinator." : "Save your answer quietly, without a message."}</p>
      <div className="project-actions">
        <button className="project-primary" disabled={!canSubmit}>
          {busy ? "Saving…" : notify ? "Send answer" : "Save quietly"}
        </button>
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await answer({ action: "question-close", decision: item.ref, note: detail }); }
          catch (e) { setError(describeError(e)); } finally { setBusy(false); }
        }}>Close quietly</button>
      </div>
      <p className="project-hint">Close quietly when already resolved in chat. No answer is recorded; the coordinator is not notified.</p>
    </form>
  );
}

function CoordinatorSwitch({
  project,
  command,
  close,
}: {
  project: Overview["project"];
  command: (command: Command) => Promise<unknown>;
  close: () => void;
}) {
  // Untouched means inherit: the command omits `profile` and the service
  // carries the incumbent's effective model, reasoning, approval mode and
  // service tier. Choosing a model is an explicit override.
  const [profileOverride, setProfileOverride] = useState<Profile | null>(null);
  const [checkpoint, setCheckpoint] = useState(project.checkpoint ?? "");
  const [reason, setReason] = useState("Switch coordinator model");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const running = ["active", "starting", "stopping"].includes(
    project.coordinatorStatus,
  );
  const unconfirmed = ["pending", "uncertain"].includes(
    project.coordinatorStart?.state ?? "",
  );
  // A start that settles after this form reported it drops the stale error.
  const settled = project.coordinatorStart?.state === "done";
  useEffect(() => {
    if (settled) setError(null);
  }, [settled, project.coordinatorGeneration]);
  return (
    <form
      className="project-card"
      aria-label="Replace coordinator"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const result = (await command({
            action: "replace-coordinator",
            ...(profileOverride ? { profile: profileOverride } : {}),
            reason,
            ...(checkpoint.trim() ? { checkpoint } : {}),
          })) as { state?: string } | null;
          // "checkout-pending" started the replacement; the strip shows
          // its confirmation, so the form closes as on success.
          if (result?.state === "pending") {
            setQueued(true);
          } else {
            close();
          }
        } catch (e) {
          setError(describeError(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Replace coordinator</h3>
      <p className="project-muted">
        Start a fresh coordinator with the initiative's tasks, decisions and
        this checkpoint. Every recorded member moves before the old coordinator
        archives; it stays in history.
      </p>
      <label className="project-option">
        <input
          type="checkbox"
          checked={profileOverride !== null}
          disabled={busy}
          onChange={(e) =>
            setProfileOverride(
              e.target.checked
                ? (project.policy.profiles.coordinator ??
                    project.profileDefaults?.coordinator ??
                    DEFAULT_PROFILES.coordinator)
                : null,
            )
          }
        />
        <span>Choose a different model</span>
      </label>
      {profileOverride ? (
        <ProviderModelPicker
          value={profileOverride}
          disabled={busy}
          onChange={(value) =>
            setProfileOverride({
              providerId: value.providerId,
              model: value.model,
              reasoningLevel: value.reasoningLevel,
              ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}),
            })
          }
        />
      ) : (
        <p className="project-muted">
          The new coordinator inherits the current coordinator's model,
          reasoning effort, approval mode and service tier.
        </p>
      )}

      <label className="project-field">
        Reason
        <input
          value={reason}
          maxLength={2000}
          required
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label className="project-field">
        Handoff checkpoint
        <AutoTextarea
          value={checkpoint}
          rows={4}
          maxLength={6000}
          onChange={(e) => setCheckpoint(e.target.value)}
        />
      </label>
      {queued ? (
        <p className="project-note">
          Queued — the replacement starts when the current coordinator's turn
          ends naturally; it does not interrupt running work. Close this form to
          withdraw it from the coordinator strip.
        </p>
      ) : (
        <>
          {running && (
            <p className="project-note">
              The current coordinator is still working — the replacement will be
              queued and take over when its turn ends.
            </p>
          )}
          {unconfirmed && (
            <p className="project-note">
              A coordinator start is still unconfirmed — the replacement queues
              behind it and runs once the start settles.
            </p>
          )}
        </>
      )}
      <ErrorNotice message={error} />
      <div className="project-actions">
        {queued ? (
          <button type="button" className="project-primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button className="project-primary" disabled={busy}>
              {busy ? "Starting…" : "Start replacement"}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </>
        )}
      </div>
    </form>
  );
}

const toLines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

type EditorBaseline = {
  name: string;
  objective: string;
  context: ProjectContext;
};

const snapshotOf = (project: Overview["project"]): EditorBaseline => ({
  name: project.name,
  objective: project.objective,
  context: {
    vision: project.context.vision,
    objectives: [...project.context.objectives],
    ideas: [...project.context.ideas],
  },
});

function ProjectEditor({
  project,
  command,
  refresh,
  close,
}: {
  project: Overview["project"];
  command: (command: Command) => Promise<unknown>;
  refresh: () => Promise<void>;
  close: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [purpose, setPurpose] = useState(project.objective);
  const [vision, setVision] = useState(project.context.vision);
  const [objectives, setObjectives] = useState(
    project.context.objectives.join("\n"),
  );
  const [ideas, setIdeas] = useState(project.context.ideas.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const uid = useId();
  const baseline = useRef<EditorBaseline>(snapshotOf(project));
  const diffs = conflict
    ? (
        [
          ["Name", project.name, name, baseline.current.name],
          [
            "Initiative purpose",
            project.objective,
            purpose,
            baseline.current.objective,
          ],
          [
            "Vision",
            project.context.vision,
            vision,
            baseline.current.context.vision,
          ],
          [
            "Objectives",
            project.context.objectives.join("\n"),
            objectives,
            baseline.current.context.objectives.join("\n"),
          ],
          [
            "Ideas",
            project.context.ideas.join("\n"),
            ideas,
            baseline.current.context.ideas.join("\n"),
          ],
        ] as const
      ).filter(([, current, , old]) => current !== old)
    : [];
  const keepEdits = () => {
    const keep = (draft: string, old: string, current: string) =>
      draft === old ? current : draft;
    const now = snapshotOf(project);
    setName(keep(name, baseline.current.name, now.name));
    setPurpose(keep(purpose, baseline.current.objective, now.objective));
    setVision(
      keep(vision, baseline.current.context.vision, now.context.vision),
    );
    setObjectives(
      keep(
        objectives,
        baseline.current.context.objectives.join("\n"),
        now.context.objectives.join("\n"),
      ),
    );
    setIdeas(
      keep(
        ideas,
        baseline.current.context.ideas.join("\n"),
        now.context.ideas.join("\n"),
      ),
    );
    baseline.current = now;
    setConflict(false);
    setError(null);
  };
  return (
    <form
      className="project-card project-editor"
      aria-label="Edit initiative"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setConflict(false);
        try {
          await command({
            action: "edit",
            name: name.trim(),
            objective: purpose.trim(),
            context: {
              vision,
              objectives: toLines(objectives),
              ideas: toLines(ideas),
            },
            expected: baseline.current,
          });
          close();
        } catch (e) {
          const message = describeError(e);
          const detailsChanged =
            JSON.stringify(snapshotOf(project)) !==
            JSON.stringify(baseline.current);
          if (message.includes(PROJECT_DETAILS_CONFLICT) || detailsChanged) {
            setConflict(true);
            if (!message.includes(PROJECT_DETAILS_CONFLICT)) setError(message);
            try {
              await refresh();
            } catch {
              /* The comparison shows the values already fetched. */
            }
          } else setError(message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {conflict ? (
        <div className="project-conflict" role="alert">
          <p>
            <strong>Initiative details changed while you were editing.</strong>{" "}
            Your draft is preserved below — compare the current details, then
            keep your edits or rework them before saving again.
          </p>
          {diffs.map(([label, current, draft, old]) => (
            <div key={label} className="project-conflict-field">
              <h3>{label}</h3>
              <p>
                <span className="project-muted">Current: </span>
                <span className="project-preserve">{current || "(empty)"}</span>
              </p>
              <p>
                <span className="project-muted">Your draft: </span>
                <span className="project-preserve">
                  {draft === old
                    ? "unchanged — the current value is kept"
                    : draft || "(empty)"}
                </span>
              </p>
            </div>
          ))}
          {!diffs.length && (
            <p>
              Changed details have not loaded yet.{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                Reload current details
              </button>
            </p>
          )}
          <button
            type="button"
            disabled={busy || !diffs.length}
            onClick={keepEdits}
          >
            Keep my edits, use current details
          </button>
        </div>
      ) : null}
      <label className="project-field">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          required
          autoFocus
        />
      </label>
      <label className="project-field">
        Initiative purpose
        <AutoTextarea
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          rows={2}
          maxLength={4000}
          required
          placeholder="What this initiative exists to do."
        />
      </label>
      <label className="project-field">
        Vision
        <AutoTextarea
          value={vision}
          onChange={(e) => setVision(e.target.value)}
          rows={2}
          maxLength={2000}
          aria-describedby={`${uid}-vision-hint`}
          placeholder="Where this is heading, if it works."
        />
      </label>
      <p className="project-hint" id={`${uid}-vision-hint`}>
        Up to 2000 characters.
      </p>
      <label className="project-field">
        Objectives
        <AutoTextarea
          value={objectives}
          onChange={(e) => setObjectives(e.target.value)}
          rows={3}
          maxLength={6200}
          aria-describedby={`${uid}-objectives-hint`}
          placeholder={"One per line.\nWhat is being worked toward right now."}
        />
      </label>
      <p className="project-hint" id={`${uid}-objectives-hint`}>
        One per line. Up to 12 items, 500 characters each.
      </p>
      <label className="project-field">
        Ideas
        <AutoTextarea
          value={ideas}
          onChange={(e) => setIdeas(e.target.value)}
          rows={3}
          maxLength={6200}
          aria-describedby={`${uid}-ideas-hint`}
          placeholder={"One per line.\nPossibilities worth remembering."}
        />
      </label>
      <p className="project-hint" id={`${uid}-ideas-hint`}>
        One per line. Up to 12 items, 500 characters each.
      </p>
      <ErrorNotice message={error} />
      <div className="project-actions">
        <button
          className="project-primary"
          disabled={busy || !name.trim() || !purpose.trim()}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={close} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Dashboard({
  projectId,
  creationNote,
  variant = "page",
}: {
  projectId: string;
  creationNote?: string | null;
  variant?: "page" | "panel";
}) {
  const { mode } = useCodeTheme();
  const [answerNotice, setAnswerNotice] = useState<{ projectId: string; text: string; urgent: boolean } | null>(null);
  const [detailsNeeded, setDetailsNeeded] = useState(false);
  const api = useRpc<typeof projectsContract>();
  const navigate = useBbNavigate();
  const state = useData(`overview:${projectId}`, () =>
    api.call("overview", { projectId, detailed: false }),
  );
  const details = useData(`details:${projectId}`, () => api.call("overview", { projectId }), detailsNeeded);
  const [inventory, setInventory] = useState<
    {
      id: string;
      name: string;
      environments: {
        id: string;
        path: string | null;
        hostId: string;
        name: string | null;
        isWorktree: boolean;
        status: string;
        isDefaultHome: boolean;
      }[];
    }[]
  >([]);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const inventorySerial = useRef(0);
  const inventoryPending = useRef<Promise<void> | null>(null);
  const inventoryLoaded = useRef(false);
  const loadInventory = useCallback((force = false) => {
    if (inventoryPending.current) return inventoryPending.current;
    if (inventoryLoaded.current && !force) return Promise.resolve();
    const read = (async () => {
    const serial = ++inventorySerial.current;
    try {
      const rows = await apiRef.current.call("inventory", null);
      if (serial === inventorySerial.current) {
        inventoryLoaded.current = true;
        setInventory(rows);
        setInventoryError(null);
      }
    } catch (error) {
      if (serial === inventorySerial.current)
        setInventoryError(describeError(error));
    }
    })().finally(() => { if (inventoryPending.current === read) inventoryPending.current = null; });
    inventoryPending.current = read; return read;
  }, [projectId]);
  useEffect(() => {
    return () => {
      inventorySerial.current++;
    };
  }, [loadInventory]);
  const refresh = async () => {
    await Promise.all([state.refresh(), ...(detailsNeeded ? [details.refresh()] : []), ...(inventoryLoaded.current ? [loadInventory(true)] : [])]);
  };
  const command = async (command: Command) => {
    const end = state.begin();
    const endDetails = details.begin();
    try {
      const result = await api.call("command", { projectId, command });
      end(data => applyCommitted(data as Overview, command, result));
      endDetails(data => applyCommitted(data as Overview, command, result));
      const record = "decision" in command ? command.decision : "task" in command ? command.task : (result as { ref?: string } | null)?.ref;
      const notification = (result as { notification?: { state: string; detail?: string } } | null)?.notification;
      const meaningful = !!notification || command.action === "decision-accept-all" || command.action === "answer" || command.action === "question-close" || !!record && command.action !== "decision-review" && command.action !== "acknowledge";
      setAnswerNotice(meaningful ? { projectId, urgent: !!notification && ["failed", "uncertain", "pending"].includes(notification.state), text: `${record ? `${record}: ` : ""}${command.action === "decision-accept-all" ? `${(result as { accepted: number }).accepted} agent decision${(result as { accepted: number }).accepted === 1 ? "" : "s"} accepted` : command.action === "answer" ? "answer saved" : command.action === "decision-review" ? "review saved" : command.action === "question-close" ? "closed quietly; no answer recorded" : "saved"}.${notification ? ` Coordinator notification ${notification.state === "pending" ? "unconfirmed" : notification.state}${notification.detail ? `: ${notification.detail}` : "."}` : ""}` } : null);
      return result;
    } finally {
      end(); endDetails();
      state.schedule();
      details.schedule();
    }
  };
  const o = state.data ? { ...state.data, ...(detailsNeeded && details.data ? { detailsLoaded: true, usage: details.data.usage, memberThreads: details.data.memberThreads, workers: details.data.workers } : {}) } : null;
  return (
    <main
      className={`bb-projects bb-projects--control${variant === "panel" ? " bb-projects--panel" : ""}`}
      data-project-id={projectId}
      data-appearance={mode}
    >
      <ErrorNotice message={state.error} retry={() => void state.refresh()} />
      {o ? (
        <ControlRoom
          key={projectId}
          overview={o}
          onTab={tab => { if (["threads", "usage", "log"].includes(tab)) { setDetailsNeeded(true); } if (["threads", "context"].includes(tab)) void loadInventory(); }}
          detailNotice={detailsNeeded && !details.loaded ? "Loading thread details…" : details.error}
          inventory={inventory}
          run={command}
          readHandoff={async (ref) => {
            const result = (await api.call("read", { projectId, view: "assignments", refs: [ref], detailed: true, fields: ["standardHandoff"] })) as { items: { standardHandoff?: string | null }[] };
            return result.items[0]?.standardHandoff ?? null;
          }}
          refresh={refresh}
          openThread={(id) => navigate.toThread(id)}
          newThread={() => navigate.toPluginPanel("projects", { subPath: `${projectId}/compose` })}
          notice={
            <>
              <ErrorNotice
                message={inventoryError}
                retry={() => void loadInventory(true)}
              />
              {answerNotice?.projectId === projectId ? <p role={answerNotice.urgent ? "alert" : "status"} className={answerNotice.urgent ? "project-error" : "project-note"}>{answerNotice.text}</p> : null}
              <ErrorNotice message={details.error} retry={() => void details.refresh()} />
              {(creationNote ?? rememberedNote(projectId)) ? (
                <p className="project-note">
                  {creationNote ?? rememberedNote(projectId)}
                </p>
              ) : null}
            </>
          }
          renderOpinion={(item) => (
            <Opinion key={item.ref} item={item} answer={command} />
          )}
          renderReplacement={(close) => (
            <CoordinatorSwitch
              key={o.project.coordinatorGeneration}
              project={o.project}
              command={command}
              close={close}
            />
          )}
          renderContext={(close) => (
            <ProjectEditor
              key={o.project.id}
              project={o.project}
              command={command}
              refresh={state.refresh}
              close={close}
            />
          )}
          newTask={
            <NewTask run={command} />
          }
        />
      ) : (
        <p className="project-muted">
          {state.error
            ? "The initiative is unavailable."
            : "Loading initiative…"}
        </p>
      )}
    </main>
  );
}

function NewTask({ run }: { run: (command: Command) => Promise<unknown> }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await run({ action: "task-create", title, summary });
      setTitle("");
      setSummary("");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="project-details">
      <summary>Add a task</summary>
      <form onSubmit={submit}>
        <label className="project-field">
          Task title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
          />
        </label>
        <label className="project-field">
          What should be achieved?
          <AutoTextarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            maxLength={2000}
            required
          />
        </label>
        <ErrorNotice message={error} />
        <button className="project-primary" disabled={busy}>
          {busy ? "Adding…" : "Add task"}
        </button>
      </form>
    </details>
  );
}

function CreateProject({
  threadId,
  created,
}: {
  threadId?: string;
  created: (id: string, note: string | null) => void;
}) {
  const api = useRpc<typeof projectsContract>();
  const inventory = useData("inventory", () => api.call("inventory", null));
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [adopt, setAdopt] = useState(Boolean(threadId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = (await api.call("command", {
        command: {
          action: "create",
          name,
          objective,
          memberProjectIds: members,
          coordinator:
            adopt && threadId
              ? { kind: "adopt", threadId }
              : {
                  kind: "new",
                  bbProjectId: members[0],
                  environment: environmentId
                    ? { type: "reuse", environmentId }
                    : { type: "project-default" },
                },
        },
      })) as { project: { id: string }; note: string | null };
      rememberNote(result.project.id, result.note);
      created(result.project.id, result.note);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="bb-projects project-create" onSubmit={submit}>
      <p className="project-eyebrow">Initiative mode</p>
      <h1>Start an initiative</h1>
      <p className="project-muted">
        One coordinator, a tree of workers, and an overview you can read without
        opening every thread.
      </p>
      <label className="project-field">
        Initiative name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          required
          autoFocus
        />
      </label>
      <label className="project-field">
        What should this initiative achieve?
        <AutoTextarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={3}
          maxLength={4000}
          required
        />
      </label>
      <fieldset>
        <legend>Repositories</legend>
        <p className="project-muted">
          An initiative can span several BB projects.
        </p>
        <ErrorNotice
          message={inventory.error}
          retry={() => void inventory.refresh()}
        />
        {inventory.data?.map((p) => (
          <label className="project-option" key={p.id}>
            <input
              type="checkbox"
              checked={members.includes(p.id)}
              onChange={() => {
                setEnvironmentId("");
                setMembers((list) =>
                  list.includes(p.id)
                    ? list.filter((id) => id !== p.id)
                    : [...list, p.id],
                );
              }}
            />
            <span>{p.name}</span>
          </label>
        ))}
      </fieldset>
      {threadId && (
        <label className="project-option">
          <input
            type="checkbox"
            checked={adopt}
            onChange={(e) => setAdopt(e.target.checked)}
          />
          <span>Use this thread as the coordinator</span>
        </label>
      )}
      {!adopt && (
        <>
          <p className="project-muted">
            The coordinator will use Opus 5.5 High.
          </p>
          <label className="project-field">
            Coordinator checkout
            <select
              value={environmentId}
              onChange={(e) => setEnvironmentId(e.target.value)}
            >
              <option value="">First repository’s default checkout</option>
              {inventory.data
                ?.filter((p) => p.id === members[0])
                .flatMap((p) =>
                  // Only the proven default checkout may be named: every
                  // other environment fails the service's strict home check.
                  p.environments
                    .filter((e) => e.isDefaultHome)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.path ?? e.id} · {e.hostId}
                      </option>
                    )),
                )}
            </select>
          </label>
        </>
      )}
      <ErrorNotice message={error} />
      <button className="project-primary" disabled={busy || !members.length}>
        {busy ? "Creating…" : "Create initiative"}
      </button>
    </form>
  );
}

export function InitiativeCompose({ projectId }: { projectId: string }) {
  const api = useRpc<typeof projectsContract>();
  const navigate = useBbNavigate();
  const state = useData(`overview:${projectId}`, () => api.call("overview", { projectId, detailed: false }));
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const submit = async (request: NewThreadRequest) => {
    setError(null);
    try {
      const result = await api.call("command", { projectId, command: { action: "thread-create", request } }) as { threadId: string | null; note: string | null };
      if (result.threadId) navigate.toThread(result.threadId);
      else throw new Error(result.note ?? "BB has not confirmed creation. Inspect the Initiative before retrying.");
    } catch (failure) {
      // A lost RPC response can hide a completed native create. Preserve the
      // host draft and require receipt inspection instead of blind resubmission.
      setUncertain(true);
      setError(describeError(failure));
      throw failure;
    }
  };
  return <div className="initiative-compose">
    <button className="project-back" onClick={() => navigate.toPluginPanel("projects", { subPath: projectId })}>← {state.data?.project.name ?? "Initiative"}</button>
    <ErrorNotice message={state.error ?? error} retry={state.error ? () => void state.refresh() : undefined} />
    {uncertain ? <p className="project-note">Creation was not confirmed. Your draft is preserved. Open the Initiative to inspect the receipt before another submission.</p> :
      <NewThreadComposer defaultProjectId={state.data?.project.memberProjectIds[0]}
        draftKey={`initiative:${projectId}:new-thread`} focusRequest={1}
        onSubmit={submit} />}
  </div>;
}

export function ProjectsPage({ subPath }: PluginNavPanelProps) {
  const api = useRpc<typeof projectsContract>();
  const navigate = useBbNavigate();
  const [creationNote, setCreationNote] = useState<string | null>(null);
  const id = subPath.replace(/^\/+|\/+$/g, "");

  const open = (id: string) =>
    navigate.toPluginPanel("projects", { subPath: id });
  return (
    <div className="project-page">
      {id.endsWith("/compose") ? <InitiativeCompose projectId={id.slice(0, -8)} /> : id === "new" ? (
        <>
          <button className="project-back" onClick={() => open("")}>
            ← Initiatives
          </button>
          <CreateProject
            created={(id, note) => {
              setCreationNote(note);
              open(id);
            }}
          />
        </>
      ) : id ? (
        <>
          <button className="project-back" onClick={() => open("")}>
            ← Initiatives
          </button>
          <Dashboard key={id} projectId={id} creationNote={creationNote} />
        </>
      ) : (
        <Catalog open={open} />
      )}
    </div>
  );
}
function Catalog({ open }: { open: (id: string) => void }) {
  const api = useRpc<typeof projectsContract>();
  const list = useData("projects", () => api.call("list", null));
  return (
        <main className="bb-projects">
          <header className="project-header">
            <div>
              <p className="project-eyebrow">Initiative mode</p>
              <h1>Initiatives</h1>
            </div>
            <button className="project-primary" onClick={() => open("new")}>
              New initiative
            </button>
          </header>
          <ErrorNotice message={list.error} retry={() => void list.refresh()} />
          {list.data?.length === 0 && (
            <p className="project-muted">
              Start an initiative or adopt a coordinator from its Initiative
              panel.
            </p>
          )}
          {list.data?.map((p: ProjectSummary) => (
            <button
              className="project-catalog-card"
              key={p.id}
              onClick={() => open(p.id)}
            >
              <h2>
                {p.name}
                {p.paused && <span className="project-badge">Paused</span>}
              </h2>
              <p>{p.objective}</p>
              <span className="project-meta">
                {p.inFlight} in flight · {p.remaining} remaining
                {p.opinions ? ` · ${p.opinions} need your opinion` : ""}
                {p.revisit ? ` · ${p.revisit} decision${p.revisit === 1 ? "" : "s"} to check` : ""}
              </span>
            </button>
          ))}
        </main>
  );
}
export function ProjectPanel({ threadId }: PluginThreadPanelProps) {
  const api = useRpc<typeof projectsContract>();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [creationNote, setCreationNote] = useState<string | null>(null);
  const state = useData(`membership:${threadId}`, () =>
    api.call("membership", { threadId }),
  );
  const id = createdId ?? state.data?.projectId;
  return (
    <div className="project-page">
      <ErrorNotice message={state.error} retry={() => void state.refresh()} />
      {id ? (
        <Dashboard
          key={id}
          projectId={id}
          creationNote={creationNote}
          variant="panel"
        />
      ) : state.error ? null : !state.loaded ? (
        <p className="bb-projects bb-projects--panel project-muted">
          Loading initiative…
        </p>
      ) : (
        <CreateProject
          threadId={threadId}
          created={(id, note) => {
            setCreatedId(id);
            setCreationNote(note);
          }}
        />
      )}
    </div>
  );
}
export function ProjectHeader({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const api = useRpc<typeof projectsContract>();
  const navigate = useBbNavigate();
  const membership = useData(`header:${threadId}`, () =>
    api.call("membership", { threadId }),
  );
  if (!membership.data) return null;
  return (
    <button
      className="project-header-button"
      aria-label={`Initiative overview: ${membership.data.name}`}
      title={membership.data.name}
      onClick={() =>
        navigate.openThreadPanel({
          actionId: PROJECT_PANEL,
          title: "Initiative",
          params: { threadId },
        })
      }
    >
      {isCompactViewport ? "◈" : "◈ Initiative"}
    </button>
  );
}
export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "projects-guidance", title: "Guidance and execution defaults", component: ProjectsSettings });
  app.slots.navPanel({
    id: "projects",
    title: "Initiatives",
    icon: "Target",
    path: "projects",
    component: ProjectsPage,
  });
  app.slots.threadPanelAction({
    id: PROJECT_PANEL,
    title: "Initiative",
    icon: "Target",
    layout: "flush",
    component: ProjectPanel,
    run: ({ threadId, openPanel }) => {
      openPanel({ title: "Initiative", params: { threadId } });
    },
  });
  app.slots.experimental_threadHeaderAction({
    id: "project-status",
    title: "Initiative",
    component: ProjectHeader,
  });
});
