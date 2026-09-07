import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { isWorkingTreeTarget, type DiffEntry, type DiffTarget } from "@/lib/diff-contract";
import { acquireFileSession, peekFileSession } from "@/lib/file-session";
import { useFileSessionIo } from "@/lib/use-file-session";
import { ContextMenu, menuAt, type MenuState } from "./ContextMenu";
import { useLongPress } from "@/lib/use-long-press";

/**
 * The row's context menu: one action, named for what happens to the file.
 * It opens from a right click, a long press on a touch screen, and from the
 * keyboard's menu key or Shift+F10.
 */
export function DiffFileActions({ children, entry, target, threadId, onChanged }: {
  children: ReactNode; entry: DiffEntry; target: DiffTarget; threadId: string; onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const io = useFileSessionIo();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [confirmation, setConfirmation] = useState<{ deleting: boolean; run: () => Promise<void> } | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; detach.current?.(); }; }, []);
  const enabled = isWorkingTreeTarget(target) && !entry.binary && entry.loadMode !== "too_large"
    && ["modified", "added", "deleted"].includes(entry.changeKind);
  const label = entry.changeKind === "added" ? "Delete…" : entry.changeKind === "deleted" ? "Restore" : "Revert";
  const finish = () => {
    detach.current?.(); detach.current = null; running.current = false;
    if (mounted.current) { setBusy(false); setConfirmation(null); }
  };
  const prepare = async () => {
    if (running.current) return;
    running.current = true; setBusy(true);
    try {
      const data = await rpc.call("diffRead", { threadId, target, path: entry.path });
      if (!mounted.current) { finish(); return; }
      if (data.kind !== "text") throw new Error(data.reason);
      if (data.newContent !== null && !data.editable) throw new Error(data.reason ?? "This file is read-only");
      let session = peekFileSession(data.source, entry.path);
      if (!session && data.newContent !== null && data.sha256 !== null) {
        session = acquireFileSession({ source: data.source, path: entry.path, io,
          seed: { content: data.newContent, sha256: data.sha256, absolutePath: data.absolutePath, relativePath: data.relativePath } });
      }
      if (session) detach.current = session.attach(`revert:${crypto.randomUUID()}`);
      const snapshot = session?.getSnapshot();
      const deleting = data.oldContent === null;
      const run = async () => {
        if (!mounted.current) { finish(); return; }
        setBusy(true);
        try {
          const action = async () => {
            const result = await rpc.call("diffRevert", { threadId, target, path: entry.path,
              expectedSha256: data.sha256, expectedBaselineSha256: data.baselineSha256, confirmDelete: deleting });
            return result.kind === "deleted" ? null : result;
          };
          if (session && snapshot) await session.mutateFile(snapshot, action);
          else await action();
          onChanged();
          toast.success(deleting ? "File deleted" : data.newContent === null ? "File restored" : "File reverted");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not revert the file");
        } finally { finish(); }
      };
      if (deleting || snapshot?.dirty || (snapshot && snapshot.draft.kind !== "none")) {
        setBusy(false); setConfirmation({ deleting, run });
      } else await run();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the comparison"); finish();
    }
  };
  const items = [{ label, disabled: !enabled || busy || confirmation !== null, onSelect: () => void prepare() }];
  const press = useLongPress<HTMLDivElement>((point, anchor) => setMenu({ ...point, anchor, items }));
  return (
    <div
      {...press}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        setMenu(menuAt(event.currentTarget, items));
      }}
    >
      {children}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      {confirmation ? (
        <div role="alertdialog" aria-label={confirmation.deleting ? `Delete ${entry.path}?` : `Revert ${entry.path}?`}
          className="bg-destructive/10 px-3 py-2 text-xs" onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); finish(); } }}>
          <p>{confirmation.deleting ? `Delete ${entry.path}? This also removes any unsaved edits.` : `Revert ${entry.path} and discard its unsaved edits?`}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" autoFocus disabled={busy} onClick={finish} className="rounded px-2 py-1 hover:bg-state-hover disabled:opacity-50">Cancel</button>
            <button type="button" disabled={busy} onClick={() => void confirmation.run()} className="rounded bg-destructive px-2 py-1 text-white disabled:opacity-50">{busy ? "Working…" : confirmation.deleting ? "Delete file" : "Revert file"}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
