import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { copyText } from "@/lib/editor-commands";
import { reportCrash, type CrashContext } from "@/lib/client-log";
import { cn } from "@/lib/utils";
import { PlainTextView } from "./PlainTextView";
import { FileIcon } from "./icons";

export interface EditorTabBoundaryProps {
  /** The canonical file identity; the parent keys the boundary by it. */
  fileKey: string;
  path: string;
  /** The buffer, for the "Open as plain text" fallback. */
  content: string;
  /** Where the boundary sits, e.g. "editor" or "markdown-preview". */
  phase: string;
  /** Telemetry fields: byte/line counts, source kind, host. */
  context?: Partial<CrashContext>;
  fontSize?: number;
  lineHeight?: number;
  fontFamily?: string;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
  plainText: boolean;
}

/**
 * Keeps a file's rendering failure inside its own tab. The tree and the rest
 * of the panel live outside this boundary, so a crash in the editor surface —
 * Pierre, the Markdown renderer, or BB's own preview — replaces only the file
 * area, and the buffer underneath it is untouched.
 */
export class EditorTabBoundary extends Component<EditorTabBoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, plainText: false };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error, plainText: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportCrash({ phase: this.props.phase, path: this.props.path, ...this.props.context }, error);
    if (info.componentStack) {
      reportCrash({ phase: `${this.props.phase}:stack`, path: this.props.path, ...this.props.context },
        new Error(info.componentStack.slice(0, 400)));
    }
  }

  componentDidUpdate(previous: EditorTabBoundaryProps): void {
    // A different file starts clean; the same file keeps its error until Retry.
    if (previous.fileKey !== this.props.fileKey && (this.state.error !== null || this.state.plainText)) {
      this.setState({ error: null, plainText: false });
    }
  }

  render(): ReactNode {
    const { path, content, fontSize, lineHeight, fontFamily } = this.props;
    const { error, plainText } = this.state;
    if (error === null) {
      return <div className="relative flex min-h-0 flex-1 flex-col">{this.props.children}</div>;
    }
    if (plainText) {
      return (
        <div className="relative flex min-h-0 flex-1 flex-col bg-background" data-testid="editor-tab-fallback">
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{path} — read-only plain text after an editor error</span>
            <FallbackButton onClick={() => this.setState({ error: null, plainText: false })}>Retry the editor</FallbackButton>
            <FallbackButton onClick={() => void copyText(path, "Path copied")}>Copy path</FallbackButton>
          </div>
          <div className="relative min-h-0 flex-1">
            <PlainTextView content={content} fontSize={fontSize} lineHeight={lineHeight} fontFamily={fontFamily} />
          </div>
        </div>
      );
    }
    const message = (error.message || "Something went wrong showing this file").slice(0, 300);
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-background" data-testid="editor-tab-fallback">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <FileIcon path={path} className="size-5 text-muted-foreground" />
          <p className="max-w-md text-sm text-foreground">The editor could not show this file.</p>
          <p className="max-w-md text-xs text-muted-foreground">{path}</p>
          <p className="max-w-md text-xs text-destructive">{message}</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <FallbackButton onClick={() => this.setState({ error: null })}>Retry</FallbackButton>
            <FallbackButton onClick={() => this.setState({ plainText: true })}>Open as plain text</FallbackButton>
            <FallbackButton onClick={() => void copyText(path, "Path copied")}>Copy path</FallbackButton>
          </div>
        </div>
      </div>
    );
  }
}

function FallbackButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs text-foreground",
        "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      {children}
    </button>
  );
}
