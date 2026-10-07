// Node keeps AbortSignal.any's composites in a private set on each source signal; absent means none.
export function dependantsOf(signal: AbortSignal): number {
  const key = Object.getOwnPropertySymbols(signal).find(
    (symbol) => symbol.description === "kDependantSignals",
  );
  return key === undefined
    ? 0
    : (signal as unknown as Record<symbol, Set<unknown>>)[key].size;
}
