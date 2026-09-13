export function ThreadDragOverlay({ title }: { title: string }) {
  return (
    <div
      data-thread-drag-overlay=""
      className="w-64 max-w-[80vw] cursor-grabbing rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground opacity-95 shadow-lg"
    >
      <span className="block truncate">{title}</span>
    </div>
  );
}
