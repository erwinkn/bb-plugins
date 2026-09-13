// React binding for the DraftStore plus the submission and attachment RPCs.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  type Answer,
  type AnswerState,
  type ChangeSignal,
  type Round,
  type Submission,
  type ThreadState,
  LIMITS,
  REALTIME_CHANNEL,
  canSubmitRound,
} from "../lib/model";
import { type Notice } from "../lib/draft-store";
import { questionSession } from "../lib/question-session";

export type SubmitOutcome =
  | { kind: "submitted"; submission: Submission }
  | { kind: "conflict"; labels: string[] }
  | { kind: "in-flight"; labels: string[] }
  | { kind: "nothing" }
  | { kind: "error"; message: string };

export interface PathHit {
  path: string;
  name: string;
  kind: "file" | "directory";
}

export interface PathSearch {
  environmentId: string | null;
  hostId: string | null;
  hits: PathHit[];
  unavailable: string | null;
}

export interface QuestionsController {
  threadId: string;
  status: "loading" | "ready" | "error";
  error: string | null;
  rounds: Round[];
  answers: Map<string, AnswerState>;
  labels: Map<string, string>;
  submissions: Submission[];
  summary: ThreadState["summary"];
  draftOf(questionId: string): Answer;
  statusOf(questionId: string): "empty" | "draft" | "done";
  conflictOf(questionId: string): AnswerState | null;
  resolveConflict(questionId: string, choice: "mine" | "saved"): void;
  saving: boolean;
  draftStatus: "loading" | "saving" | "saved" | "unsaved" | "conflict";
  submitting: boolean;
  backupMode: "browser" | "none";
  notices: Notice[];
  dismissNotice(id: number): boolean;
  update(questionId: string, updater: (draft: Answer) => Answer): void;
  clear(questionId: string): void;
  flush(): Promise<void>;
  submit(roundId: string): Promise<SubmitOutcome>;
  /** Restore a cancelled submission's frozen answers as drafts and submit its round again. */
  resubmit(submission: Submission): Promise<SubmitOutcome>;
  uploadAttachment(questionId: string, file: File): Promise<void>;
  attachmentPreview(questionId: string, path: string): Promise<string | null>;
  searchPaths(query: string): Promise<PathSearch>;
  refetch(): void;
}

function newSubmissionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function useQuestions(threadId: string): QuestionsController {
  const rpc = useRpc<typeof rpcContract>();
  const transport = useMemo(
    () => ({
      loadState: () => rpc.call("questions_state", { threadId }),
      saveDraft: (questionId: string, draft: Answer, expectedVersion: number) =>
        rpc.call("questions_save_draft", { threadId, questionId, draft, expectedVersion }),
    }),
    [rpc, threadId],
  );
  const session = useMemo(() => questionSession(threadId, transport), [threadId, transport]);
  const store = session.store;
  useEffect(() => session.retain(transport), [session, transport]);
  useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    () => store.snapshot(),
    () => store.snapshot(),
  );

  useRealtime(REALTIME_CHANNEL, (payload) => {
    const signal = payload as Partial<ChangeSignal> | null;
    if (signal && signal.threadId === threadId) store.refresh();
  });
  const connection = useRealtimeConnectionState();
  const seenConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && seenConnection.current === "reconnecting") {
      store.refresh();
      store.retryNow();
    }
    seenConnection.current = connection;
  }, [connection, store]);

  const submitting = useSyncExternalStore(session.subscribe, () => session.submitting, () => session.submitting);

  const labels = store.labels;
  const rounds = store.rounds;
  const answers = useMemo(() => {
    const map = new Map<string, AnswerState>();
    for (const round of rounds) {
      for (const question of round.questions) {
        const state = store.effectiveState(question.id);
        if (state) map.set(question.id, state);
      }
    }
    return map;
    // The store snapshot drives re-renders; reading it here keeps the map fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds, store, store.snapshot()]);

  const finishSubmit = useCallback(
    (result: Awaited<ReturnType<typeof rpc.call<"questions_submit">>>): SubmitOutcome => {
      store.refresh();
      switch (result.outcome) {
        case "submitted":
          return { kind: "submitted", submission: result.submission };
        case "conflict":
          return { kind: "conflict", labels: result.questionIds.map((id) => labels.get(id) ?? id) };
        case "in-flight":
          return { kind: "in-flight", labels: result.questionIds.map((id) => labels.get(id) ?? id) };
        default:
          return { kind: "nothing" };
      }
    },
    [labels, store],
  );

  const submit = useCallback(
    async (roundId: string): Promise<SubmitOutcome> => {
      if (session.submitting) return { kind: "error", message: "A submission is already running." };
      session.setSubmitting(true);
      let sendStarted = false;
      try {
        await store.flush();
        const round = store.rounds.find((r) => r.id === roundId);
        if (!round) return { kind: "nothing" };
        const states = new Map(round.questions.map((q) => [q.id, store.effectiveState(q.id)!]));
        if (!canSubmitRound(round, states)) return { kind: "error", message: "Answer every required question before submitting this round." };
        const ids = round.questions.map((q) => q.id);
        const items = ids.map((questionId) => ({
          questionId,
          expectedVersion: store.serverAnswer(questionId)?.version ?? 0,
        }));
        // A repeat attempt after a transport failure reuses the id, so the
        // server replays the stored outcome instead of sending twice.
        const key = items.map((item) => `${item.questionId}@${item.expectedVersion}`).join("|");
        const submissionId =
          session.pendingSubmit && session.pendingSubmit.key === key ? session.pendingSubmit.id : newSubmissionId();
        session.pendingSubmit = { id: submissionId, key };
        sendStarted = true;
        const result = await rpc.call("questions_submit", { threadId, submissionId, items });
        session.pendingSubmit = null;
        return finishSubmit(result);
      } catch (cause) {
        if (!sendStarted) return { kind: "error", message: messageOf(cause) };
        store.refresh();
        return {
          kind: "error",
          message: `The submission was not confirmed (${messageOf(cause)}). Your answers are still drafts. Check the thread for a message with this submission before you send again.`,
        };
      } finally {
        session.setSubmitting(false);
      }
    },
    [finishSubmit, rpc, store, session, threadId],
  );

  const resubmit = useCallback(
    async (submission: Submission): Promise<SubmitOutcome> => {
      const round = store.rounds.find((item) => item.questions.some((question) => submission.questionIds.includes(question.id)));
      if (!round) return { kind: "nothing" };
      for (const question of round.questions) {
        const frozen = submission.snapshot[question.id];
        if (frozen) store.edit(question.id, () => frozen);
      }
      return submit(round.id);
    },
    [store, submit],
  );

  const uploadAttachment = useCallback(
    (questionId: string, file: File) => {
      const job = session.uploadQueue.then(async () => {
        if (file.size > LIMITS.attachmentBytes) {
          throw new Error(`${file.name} is larger than ${Math.round(LIMITS.attachmentBytes / (1024 * 1024))} MB.`);
        }
        const dataBase64 = await readFileBase64(file);
        await store.flush();
        const expectedVersion = store.serverAnswer(questionId)?.version ?? 0;
        const beforePaths = store.draftOf(questionId).attachments.map((item) => item.path);
        const releaseSaves = store.holdSaves(questionId);
        try {
          const result = await rpc.call("questions_upload_attachment", {
            threadId,
            questionId,
            expectedVersion,
            name: file.name,
            mimeType: file.type === "" ? null : file.type,
            dataBase64,
          });
          if (result.outcome === "conflict") {
            store.replaceServerAnswer(result.state);
            store.refresh();
            throw new Error("This answer changed in another window before the upload; the file was not attached. Try again.");
          }
          store.mergeUploaded(result.state, beforePaths);
        } finally {
          releaseSaves();
        }
      });
      session.uploadQueue = job.catch(() => undefined);
      return job;
    },
    [rpc, store, session, threadId],
  );

  const attachmentPreview = useCallback(
    async (questionId: string, path: string) => {
      try {
        const result = await rpc.call("questions_attachment_preview", { threadId, questionId, path });
        return result.dataUrl;
      } catch {
        return null;
      }
    },
    [rpc, threadId],
  );

  const searchPaths = useCallback(
    async (query: string): Promise<PathSearch> => {
      const result = await rpc.call("questions_search_paths", { threadId, query });
      return { environmentId: result.environmentId, hostId: result.hostId, hits: result.hits, unavailable: result.unavailable };
    },
    [rpc, threadId],
  );

  return {
    threadId,
    status: store.status,
    error: store.error,
    rounds,
    answers,
    labels,
    submissions: store.submissions,
    summary: store.summary,
    draftOf: (questionId) => store.draftOf(questionId),
    statusOf: (questionId) => store.statusOf(questionId),
    conflictOf: (questionId) => store.localEdit(questionId)?.conflict ?? null,
    resolveConflict: (questionId, choice) => store.resolveConflict(questionId, choice),
    saving: store.saving,
    draftStatus: store.draftStatus,
    submitting,
    backupMode: store.backupMode,
    notices: store.currentNotices,
    dismissNotice: (id) => store.dismissNotice(id),
    update: (questionId, updater) => store.edit(questionId, updater),
    clear: (questionId) => store.clear(questionId),
    flush: () => store.flush(),
    submit,
    resubmit,
    uploadAttachment,
    attachmentPreview,
    searchPaths,
    refetch: () => store.refresh(),
  };
}
