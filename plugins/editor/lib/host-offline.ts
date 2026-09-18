/**
 * Host-offline detection shared by the server's error translation and the
 * workbench's offline state. The daemon's raw failure ("HTTP 502: Host is
 * not connected") names no host; the server rewrites it through
 * `hostOfflineMessage`, and the client recognizes either shape.
 */

/** The daemon's raw shapes and the server's translated message. */
export function isHostOfflineMessage(message: string): boolean {
  return /host[^\n]*\bis not connected\b|host is unavailable|host_unavailable/i.test(message);
}

/** The readable error the server throws for a disconnected host. */
export function hostOfflineMessage(hostName: string | null): string {
  return hostName === null
    ? "This workspace's host is not connected"
    : `Host ${hostName} is not connected`;
}
