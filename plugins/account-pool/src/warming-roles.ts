// The roles warming tells apart. Kept free of server-only imports: the settings screen
// (feature-settings.tsx) reads it through warming-config.ts in the browser bundle.
export const warmingRoles = [
  "coordinator",
  "worker",
  "reviewer",
  "standalone",
] as const;
export type WarmingRole = (typeof warmingRoles)[number];
