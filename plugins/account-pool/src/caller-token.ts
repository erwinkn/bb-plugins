// The hub token a provider process presents also names the BB project of the thread it runs for:
// "<host token>;project=<projectId>". The provider env hook writes it once per session, from the
// project BB starts the session in, and the provider sends it on every request: Claude Code as its
// bearer token, Codex as x-bb-account-pool-token. The hub then routes a request to the accounts
// scoped to that project from the token alone, with no lookup: a session BB has not linked to its
// thread yet (every fresh session) still reaches its project's gateway.
//
// It rides in the token because BB matches plugin HTTP routes by exact path, so a base URL cannot
// carry it either. A bare host token (a session started before this format) names no project; the
// hub then falls back to the project of the session's linked thread.
//
// The project is the caller's own claim, checked by nothing but the host token next to it, so a
// process holding the host token can reach a project's scoped accounts by naming the project.
// Scoping routes traffic; it was never access control against a token holder, which runs as the
// user whose files hold every account's key.

const PROJECT_MARK = ";project=";
const ID = /^[A-Za-z0-9_-]{1,128}$/u;

// The token for a thread of `projectId`; the bare host token when the id cannot be carried.
export function callerToken(hostToken: string, projectId: string): string {
  return ID.test(projectId) ? `${hostToken}${PROJECT_MARK}${projectId}` : hostToken;
}

// The host token to authenticate, and the project the caller names. A malformed project leaves the
// whole value as the host token, which then fails to authenticate.
export function parseCallerToken(presented: string): { hostToken: string; projectId: string | null } {
  const mark = presented.indexOf(PROJECT_MARK);
  if (mark < 0) return { hostToken: presented, projectId: null };
  const projectId = presented.slice(mark + PROJECT_MARK.length);
  return ID.test(projectId)
    ? { hostToken: presented.slice(0, mark), projectId }
    : { hostToken: presented, projectId: null };
}
