// Shared by the server and the frontend bundle. Keep this file free of
// `@get-bb/plugin-sdk` imports: only `/app` is available to the frontend.

/**
 * May the environment's branch PR be presented as the thread's own? Only a
 * thread-dedicated worktree qualifies: a shared project checkout has a branch
 * that moves independently of the threads on it (its PR is not theirs), and
 * a checkout sitting on its default branch attributes that branch's PR to
 * every thread sharing it.
 */
export function isBranchPullRequestEnvironment(environment: {
  isWorktree: boolean;
  branchName: string | null;
  defaultBranch: string | null;
}): boolean {
  return (
    environment.isWorktree &&
    environment.branchName !== null &&
    environment.branchName !== "" &&
    environment.branchName !== environment.defaultBranch
  );
}
