// One question's answer editor: options, free text, attachments,
// references, confidence, and citations of earlier submitted answers.
// Layout follows the approved prototype: every control sits at the left
// edge under the title row, with no hanging indent.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  type Answer,
  type AnswerState,
  type Attachment,
  type Confidence,
  type Question,
  CONFIDENCE_LEVELS,
  answerText,
  answersEqual,
  findQuestion,
  formatBytes,
  hasContent,
} from "@/lib/model";
import type { QuestionsController } from "@/hooks/useQuestions";
import { Hint, IconButton, PanelButton, Radio, TextArea } from "./primitives";
import { ReferencePicker } from "./ReferencePicker";

function timeOf(timestamp: number | null): string {
  if (timestamp === null) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Compact citation of an earlier answer; expanding replaces it in place. */
function Citation({
  controller,
  citedId,
  onJump,
}: {
  controller: QuestionsController;
  citedId: string;
  onJump: (questionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const found = findQuestion(controller.rounds, citedId);
  if (!found) return null;
  const { round, question } = found;
  const label = controller.labels.get(citedId) ?? citedId;
  const state: AnswerState | undefined = controller.answers.get(citedId);
  const submitted = state?.submitted ?? null;
  const sentText = submitted && hasContent(submitted) ? answerText(question, submitted) : null;
  const source = `Round ${round.number} · ${label}`;
  const dirty = state !== undefined && state.draft !== null && submitted !== null && !answersEqual(state.draft, submitted);
  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        className="inline-flex max-w-full cursor-pointer items-baseline gap-1.5 rounded-md border-0 bg-[var(--surface-recessed)] px-2 py-[3px] text-left text-[12px] text-muted-foreground hover:bg-[var(--state-hover)] hover:text-foreground @max-[26rem]:flex @max-[26rem]:w-full @max-[26rem]:flex-col @max-[26rem]:items-start @max-[26rem]:gap-[3px] @max-[26rem]:px-2 @max-[26rem]:py-1.5"
        onClick={() => setOpen(true)}
      >
        <span className="whitespace-nowrap">{source}</span>
        <span className="max-w-[260px] truncate italic text-[var(--subtle-foreground)] @max-[26rem]:max-w-full @max-[26rem]:whitespace-normal @max-[26rem]:[overflow-wrap:anywhere]">
          {sentText ?? "No submitted answer yet"}
        </span>
      </button>
    );
  }
  return (
    <div className="w-full border-l-2 border-[var(--input)] py-0.5 pb-1.5 pl-2.5 pr-2.5 text-[12px] text-muted-foreground">
      <div className="flex items-center gap-1.5 text-[var(--subtle-foreground)]">
        <span aria-label={sentText ? `Submitted at ${timeOf(state?.submittedAt ?? null)}` : "No submitted answer"}>{source}</span>
        <IconButton icon="ArrowUpRight" label={`Go to ${label}`} size={22} onClick={() => onJump(citedId)} />
        <IconButton icon="X" label={`Collapse reference to ${label}`} size={22} className="ml-auto" aria-expanded onClick={() => setOpen(false)} />
      </div>
      <div className="mt-0.5 text-[13px] font-medium leading-[1.5] text-foreground">{question.title}</div>
      <div className="mb-1 mt-2.5 rounded-md bg-[var(--surface-recessed)] px-2.5 py-2 leading-[1.5] text-foreground">
        <span className="mb-[3px] block text-[11px] text-[var(--subtle-foreground)]">Your answer</span>
        {sentText ? (
          <>
            {sentText}
            {submitted?.confidence ? ` · confidence ${submitted.confidence}` : ""}
          </>
        ) : (
          "Not submitted yet."
        )}
      </div>
      {dirty ? <Hint className="mb-1 block">Unsent edits are not shown here.</Hint> : null}
    </div>
  );
}

function AttachmentChip({
  attachment,
  preview,
  onRemove,
}: {
  attachment: Attachment;
  preview: string | null;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-[var(--surface-raised)] py-[3px] pl-1.5 pr-1 text-[12px]">
      {preview ? (
        <img src={preview} alt="" className="size-7 rounded-[3px] object-cover" />
      ) : (
        <Icon name={attachment.type === "localImage" ? "FileAttachment" : "File"} fallback="File" className="size-3.5 text-[var(--subtle-foreground)]" />
      )}
      <span className="max-w-40 truncate" aria-label={attachment.name}>
        {attachment.name}
      </span>
      <Hint>{formatBytes(attachment.sizeBytes)}</Hint>
      <button
        type="button"
        aria-label={`Remove ${attachment.name}`}
        className="grid size-[18px] cursor-pointer place-items-center rounded-[3px] border-0 bg-transparent text-[var(--subtle-foreground)] hover:bg-[var(--state-hover)] hover:text-foreground"
        onClick={onRemove}
      >
        <Icon name="X" className="size-3.5" />
      </button>
    </span>
  );
}

function AttachmentList({
  questionId,
  attachments,
  preview,
  onRemove,
}: {
  questionId: string;
  attachments: Attachment[];
  preview: QuestionsController["attachmentPreview"];
  onRemove: (attachment: Attachment) => void;
}) {
  const [previews, setPreviews] = useState<Map<string, string>>(() => new Map());
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const keys = attachments.filter((item) => item.type === "localImage").map((item) => item.path).join("\n");
  useEffect(() => {
    for (const path of keys.split("\n").filter((item) => item !== "")) {
      if (requested.current.has(path)) continue;
      requested.current.add(path);
      preview(questionId, path).then((dataUrl) => {
        if (dataUrl === null) {
          // Not an image, too large, or failed: allow a later retry.
          requested.current.delete(path);
          return;
        }
        if (mounted.current) setPreviews((current) => new Map(current).set(path, dataUrl));
      });
    }
  }, [keys, preview, questionId]);
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <AttachmentChip
          key={attachment.path}
          attachment={attachment}
          preview={previews.get(attachment.path) ?? null}
          onRemove={() => onRemove(attachment)}
        />
      ))}
    </div>
  );
}

export interface QuestionEditorProps {
  controller: QuestionsController;
  question: Question;
  /** Panel mode shows citations, attachments, references, confidence. */
  full: boolean;
  onJump?: (questionId: string) => void;
  onError?: (message: string) => void;
  /** Rendered before the option list; the inline card uses it for the title. */
  header?: ReactNode;
}

export function QuestionEditor({ controller, question, full, onJump, onError, header }: QuestionEditorProps) {
  const groupName = useId();
  const draft = controller.draftOf(question.id);
  const [uploadCount, setUploadCount] = useState(0);
  const uploading = uploadCount > 0;
  const fileInput = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const detailRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const [focusDetail, setFocusDetail] = useState<string | null>(null);
  const [focusText, setFocusText] = useState(false);

  useEffect(() => {
    if (focusDetail !== null) {
      detailRefs.current.get(focusDetail)?.focus();
      setFocusDetail(null);
    }
  }, [focusDetail]);
  useEffect(() => {
    if (focusText) {
      textRef.current?.focus();
      setFocusText(false);
    }
  }, [focusText]);

  const update = (updater: (current: Answer) => Answer) => controller.update(question.id, updater);
  const hasOptions = question.options.length > 0;
  const showAttachments = full && question.attachments;
  // Earlier versions allowed notes alongside a single choice. Keep those
  // notes visible and editable without checking a second radio or migrating data.
  const legacyNotes = question.select === "single" && draft.selected.length > 0 && draft.other !== true && draft.text !== "";
  const otherSelected = !legacyNotes && (draft.other ?? (draft.text !== ""));
  const showText = !hasOptions || otherSelected || legacyNotes;
  const help = question.help;

  const selectOption = (optionId: string, checked: boolean) => {
    update((current) => {
      if (question.select === "single") return { ...current, selected: [optionId], other: false, text: legacyNotes ? current.text : "", details: Object.fromEntries(Object.entries(current.details).filter(([id]) => id === optionId)) };
      if (checked) {
        return current.selected.includes(optionId) ? current : { ...current, selected: [...current.selected, optionId] };
      }
      const details = { ...current.details };
      delete details[optionId];
      return { ...current, selected: current.selected.filter((id) => id !== optionId), details };
    });
  };

  const selectOther = (checked: boolean) => {
    update((current) => ({
      ...current,
      other: checked,
      text: checked ? current.text : "",
      ...(checked && question.select === "single" ? { selected: [], details: {} } : {}),
    }));
    if (checked) setFocusText(true);
  };

  const toggleDetail = (optionId: string) => {
    const has = draft.details[optionId] !== undefined;
    update((current) => {
      const details = { ...current.details };
      if (has) delete details[optionId];
      else details[optionId] = "";
      return { ...current, details };
    });
    if (!has) setFocusDetail(optionId);
  };

  const attach = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setUploadCount((count) => count + 1);
    try {
      for (const file of Array.from(files)) {
        await controller.uploadAttachment(question.id, file);
      }
    } catch (cause) {
      onError?.(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploadCount((count) => count - 1);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const conflict = controller.conflictOf(question.id);

  return (
    <div className="px-3 pb-3 pt-1" data-question={question.id}
      onPaste={(event) => {
        if (!showAttachments || !(event.target instanceof HTMLTextAreaElement)) return;
        const files = Array.from(event.clipboardData.items)
          .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
          .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
        if (files.length === 0) return;
        if (!event.clipboardData.getData("text/plain")) event.preventDefault();
        void attach(files);
      }}>
      {header}
      {help ? <div className="mt-1 text-[12px] text-muted-foreground">{help}</div> : null}
      {conflict ? (
        <div role="alert" className="mt-1.5 rounded-md border border-[var(--surface-destructive-border)] bg-[var(--surface-destructive)] px-2.5 py-2 text-[12px]">
          <div className="font-medium text-foreground">This answer was changed in another window.</div>
          <div className="mt-0.5 text-muted-foreground">
            Saved version: {conflict.draft && hasContent(conflict.draft) ? answerText(question, conflict.draft) : "empty"}. Your edit here is kept until you choose.
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <PanelButton small onClick={() => controller.resolveConflict(question.id, "mine")}>Keep mine</PanelButton>
            <PanelButton small onClick={() => controller.resolveConflict(question.id, "saved")}>Use saved</PanelButton>
          </div>
        </div>
      ) : null}
      {full && question.cites.length > 0 ? (
        <div className="mt-1.5 flex flex-col items-start gap-1">
          {question.cites.map((citedId) => (
            <Citation key={citedId} controller={controller} citedId={citedId} onJump={(id) => onJump?.(id)} />
          ))}
        </div>
      ) : null}

      {hasOptions ? (
        <div role="group" aria-label={question.title} className="-ml-2 mt-2 flex flex-col gap-px">
          {question.options.map((option) => {
            const on = draft.selected.includes(option.id);
            const hasDetail = draft.details[option.id] !== undefined;
            const inputId = `${groupName}-${option.id}`;
            return (
              <div key={option.id} className="rounded-md">
                <label
                  htmlFor={inputId}
                  className={cn(
                    "flex min-h-7 cursor-pointer items-center gap-2.5 rounded-md px-2 py-[3px] text-[13px] hover:bg-[var(--state-hover)]",
                    on && "bg-[var(--surface-selected)]",
                  )}
                >
                  {question.select === "single" ? (
                    <Radio id={inputId} name={groupName} checked={on} onChange={() => selectOption(option.id, true)} />
                  ) : (
                    <Checkbox id={inputId} checked={on} onCheckedChange={(checked) => selectOption(option.id, checked === true)} />
                  )}
                  <span className="flex-1">{option.label}</span>
                  {on && full ? (
                    <button
                      type="button"
                      className="cursor-pointer rounded-sm border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-[var(--subtle-foreground)] hover:bg-[var(--state-hover)] hover:text-foreground"
                      onClick={(event) => {
                        event.preventDefault();
                        toggleDetail(option.id);
                      }}
                    >
                      {hasDetail ? "Remove detail" : "+ detail"}
                    </button>
                  ) : null}
                </label>
                {on && full && hasDetail ? (
                  <div className="pb-2 pl-8 pr-2 pt-0.5">
                    <TextArea
                      ref={(element: HTMLTextAreaElement | null) => {
                        if (element) detailRefs.current.set(option.id, element);
                        else detailRefs.current.delete(option.id);
                      }}
                      rows={2}
                      placeholder="Why this option, or what to watch for"
                      aria-label={`Detail for ${option.label}`}
                      value={draft.details[option.id] ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        update((current) => ({ ...current, details: { ...current.details, [option.id]: value } }));
                      }}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
          <div className="flex items-center">
            <label className="flex min-h-7 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-2 py-[3px] text-[13px]">
              {question.select === "single" ? (
                <Radio name={groupName} checked={otherSelected} onChange={() => selectOther(true)} onClick={(event) => { if (otherSelected) { event.preventDefault(); selectOther(false); } }} />
              ) : (
                <Checkbox checked={otherSelected} onCheckedChange={(checked) => selectOther(checked === true)} />
              )}
              <span>Other</span>
            </label>
            {showAttachments && !showText ? (
              <IconButton icon="Paperclip" label="Attach file or image" size={26} className="mr-2" disabled={uploading} onClick={() => fileInput.current?.click()} />
            ) : null}
          </div>
        </div>
      ) : null}

      {showText ? (
        <div className={cn(hasOptions ? "mt-0.5 ml-6" : "mt-2", showAttachments && "relative")}>
          <TextArea
            ref={textRef}
            rows={2}
            aria-label={legacyNotes ? "Additional notes" : hasOptions ? "Answer in your own words" : "Your answer"}
            placeholder={hasOptions ? "Something else, or a mix of options" : "Type here"}
            className={cn(showAttachments && "min-h-[70px]")}
            value={draft.text}
            onChange={(event) => {
              const value = event.target.value;
              update((current) => ({ ...current, text: value }));
            }}
          />
          {showAttachments ? (
            <IconButton
              icon="Paperclip"
              label="Attach file or image"
              size={26}
              className="absolute right-[5px] top-[5px] bg-background shadow-[-5px_3px_7px_3px_var(--background)]"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            />
          ) : null}
        </div>
      ) : null}

      {showAttachments ? <input ref={fileInput} type="file" multiple className="sr-only" aria-label="Choose files" onChange={(event) => void attach(event.target.files)} /> : null}

      {full && question.confidence ? (
        <div className="mt-2 flex items-center gap-2.5">
          <Hint>Confidence</Hint>
          <div role="group" aria-label="Confidence" className="inline-flex gap-0.5 rounded-md bg-[var(--surface-recessed)] p-0.5">
            {CONFIDENCE_LEVELS.map((level: Confidence) => {
              const pressed = draft.confidence === level;
              return (
                <button
                  key={level}
                  type="button"
                  aria-pressed={pressed}
                  className={cn(
                    "cursor-pointer rounded-sm border-0 bg-transparent px-2 py-0.5 text-[12px] text-muted-foreground hover:text-foreground",
                    pressed && "bg-background text-foreground shadow-[var(--shadow-sm)]",
                  )}
                  onClick={() => update((current) => ({ ...current, confidence: pressed ? null : level }))}
                >
                  {level}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {showAttachments ? (
        <AttachmentList
          questionId={question.id}
          preview={controller.attachmentPreview}
          attachments={draft.attachments}
          onRemove={(attachment) =>
            update((current) => ({ ...current, attachments: current.attachments.filter((item) => item.path !== attachment.path) }))
          }
        />
      ) : null}

      {full && question.references ? (
        <ReferencePicker
          questionId={question.id}
          references={draft.references}
          onChange={(references) => update((current) => ({ ...current, references }))}
          search={controller.searchPaths}
        />
      ) : null}
      {uploading ? <Hint className="mt-1 block">Uploading…</Hint> : null}
    </div>
  );
}
