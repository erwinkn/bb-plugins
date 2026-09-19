import { Component, useEffect } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { bindClientLog, reportCrash } from "@/lib/client-log";
import { cn } from "@/lib/utils";

export interface SurfaceBoundaryProps {
  /** The slot this guards, e.g. "file-opener" or "files-panel". */
  phase: string;
  /** The open file, for telemetry and for resetting a file-specific crash. */
  path?: string | null;
  children: ReactNode;
}

interface SurfaceBoundaryState {
  error: Error | null;
}

/**
 * Last-resort boundary around a whole editor surface. The tab boundary inside
 * covers only the file area; a crash in the chrome around it — the toolbar,
 * the tree, the pane's own hooks — would otherwise escape to BB's slot
 * boundary, which disables the slot for the session and leaves the plugin
 * log blind. Catching here keeps the failure recoverable and reported.
 */
export class SurfaceBoundary extends Component<SurfaceBoundaryProps, SurfaceBoundaryState> {
  state: SurfaceBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): SurfaceBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportCrash({ phase: this.props.phase, path: this.props.path ?? undefined }, error);
    if (info.componentStack) {
      reportCrash({ phase: `${this.props.phase}:stack`, path: this.props.path ?? undefined },
        new Error(info.componentStack.slice(0, 400)));
    }
  }

  componentDidUpdate(previous: SurfaceBoundaryProps): void {
    // A different file starts clean; the same file keeps its error until Retry.
    if (previous.path !== this.props.path && this.state.error !== null) this.setState({ error: null });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const message = (error.message || "Something went wrong").slice(0, 300);
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-background p-6 text-center" data-testid="surface-fallback">
        <p className="max-w-md text-sm text-foreground">The editor surface crashed.</p>
        {this.props.path ? <p className="max-w-md text-xs text-muted-foreground">{this.props.path}</p> : null}
        <p className="max-w-md text-xs text-destructive">{message}</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className={cn(
            "cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs text-foreground",
            "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          Retry
        </button>
      </div>
    );
  }
}

/**
 * A surface wrapped in its own crash boundary, with the client log bound one
 * level up: a crash during the surface's first render still reaches the
 * plugin log once this mount's effect binds the sender.
 */
export function GuardedSurface({ phase, path, children }: SurfaceBoundaryProps) {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => bindClientLog(rpc), [rpc]);
  return <SurfaceBoundary phase={phase} path={path}>{children}</SurfaceBoundary>;
}
