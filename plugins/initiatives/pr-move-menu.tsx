// R2: a PR's "Move to Initiative" menu, on the list's rows and the graph's nodes alike.
import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { MoveTarget, QueuedPullRequest } from "./lib/merge-queue";
import { useLongPress, useRowMenu } from "./control-room";

/** Moves a PR to an Initiative (by id), or out of every one with null. */
export type MovePr = (url: string, initiative: string | null) => Promise<unknown>;

/** The open menu: whose, and where in its row. */
export type PrMenuAt = { url: string; x: number; y: number };

/** A PR's menu: open or not, and what it can do; `pending` while some Initiatives' repositories are being looked up. */
export type MoveMenu = { at: PrMenuAt | null; projectId: string; targets: MoveTarget[]; pending: boolean; move: MovePr; open: (x: number, y: number) => void; close: () => void };

/**
 * The Initiatives a PR can move to: those listing its repository, less the one owning it. An
 * unassigned PR's own Initiative comes first. `pending`: some Initiatives' repositories aren't
 * known yet (the server looks them up and announces them).
 */
export function moveTargets(pr: QueuedPullRequest, projectId: string, initiatives: readonly MoveTarget[]): { targets: MoveTarget[]; pending: boolean } {
  const repo = pr.repo.toLowerCase();
  const fits = initiatives.filter((t) => t.repos?.includes(repo) && !(!pr.unassigned && t.id === projectId));
  return {
    targets: [...fits.filter((t) => t.id === projectId), ...fits.filter((t) => t.id !== projectId)],
    pending: initiatives.some((t) => t.repos === null),
  };
}

/** "Move to Initiative": one choice per target, and Unassign for a PR an Initiative owns. */
function PrMenu({ pr, at, projectId, targets, pending, move, close }: {
  pr: QueuedPullRequest; at: PrMenuAt; projectId: string; targets: MoveTarget[]; pending: boolean; move: MovePr; close: (refocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [write, setWrite] = useState<{ busy: boolean; error: string | null } | null>(null);
  const { place, keys } = useRowMenu(menu, at, close, [targets.length], [write?.busy, write?.error, pending]);
  const choose = async (initiative: string | null) => {
    if (write?.busy) return;
    setWrite({ busy: true, error: null });
    try {
      await move(pr.url, initiative);
      close(true);
    } catch (error) {
      setWrite({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const busy = write?.busy || undefined;
  return (
    <div ref={menu} role="menu" tabIndex={-1} aria-label={`Move #${pr.number} to an Adventure`} className="cr-split-menu cr-w-menu" style={place} onKeyDown={keys}>
      <p className="cr-w-menu-question" aria-hidden="true">Move to Adventure</p>
      {targets.map((t) => (
        <button key={t.id} type="button" role="menuitem" aria-disabled={busy} onClick={() => void choose(t.id)}>
          {t.name}{t.id === projectId ? <span className="cr-mq-menu-here"> · this one</span> : null}
        </button>
      ))}
      {!pr.unassigned ? <button type="button" role="menuitem" aria-disabled={busy} onClick={() => void choose(null)}>Unassign</button> : null}
      {pending ? <p role="status" className="cr-w-menu-question">Looking up the other Adventures' repositories…</p> : null}
      {write?.busy ? <p role="status" className="cr-w-menu-question">Moving…</p> : null}
      {write?.error ? <p role="alert" className="project-error cr-w-menu-question">{write.error}</p> : null}
    </div>
  );
}

/**
 * A PR link that opens its menu: a right click, a long press, the context-menu key or
 * Shift+F10. `item` goes on the row (the menu's positioned parent), `anchor` and `handlers` on
 * the link, `element` inside the row. A click opens the PR (`click`), except the one ending a
 * long press or the press that closes the menu. Without a menu the link is left as it is.
 */
export function useMoveMenu(pr: QueuedPullRequest, menu: MoveMenu | null, click: (event: MouseEvent<HTMLAnchorElement>) => void) {
  const item = useRef<HTMLLIElement>(null);
  const anchor = useRef<HTMLAnchorElement>(null);
  const swallowClick = useRef(false);
  const openMenu = (clientX: number, clientY: number) => {
    const box = item.current!.getBoundingClientRect();
    swallowClick.current = true;
    menu?.open(clientX - box.left, clientY - box.top);
  };
  const press = useLongPress(openMenu);
  const close = (refocus: boolean) => {
    menu?.close();
    if (refocus) anchor.current?.focus();
  };
  const handlers = menu ? {
    "aria-haspopup": "menu" as const,
    onPointerDown: (event: PointerEvent) => { swallowClick.current = !!menu.at; press.start(event); },
    onPointerMove: press.cancel,
    onPointerUp: press.cancel,
    onPointerCancel: press.cancel,
    onPointerLeave: press.cancel,
    onContextMenu: (event: MouseEvent) => { event.preventDefault(); press.cancel(); if (!menu.at) openMenu(event.clientX, event.clientY); },
    onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => {
      swallowClick.current = false;
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      menu.open(16, event.currentTarget.offsetHeight);
    },
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (swallowClick.current && event.detail !== 0) {
        event.preventDefault();
        swallowClick.current = false;
        return;
      }
      click(event);
    },
  } : {};
  const element = menu?.at
    ? <PrMenu pr={pr} at={menu.at} projectId={menu.projectId} targets={menu.targets} pending={menu.pending} move={menu.move} close={close} />
    : null;
  return { item, anchor, handlers, element };
}
