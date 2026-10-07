import { useState } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { projectsContract } from "./lib/contract";
import {
  DEFAULT_PROFILES,
  PROFILE_KEYS,
  PROFILE_ROLE_LABELS,
  policySchema,
  type Policy,
} from "./lib/schema";
import { describeProfile } from "./lib/policy";

export function ProjectsSettings() {
  const rpc = useRpc<typeof projectsContract>();
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reset, setReset] = useState<string | null>(null);
  let profiles: Policy["profiles"] | undefined;
  try {
    const raw = settings.values?.executionProfiles;
    profiles = typeof raw === "string"
      ? policySchema.parse({ profiles: JSON.parse(raw) }).profiles
      : undefined;
  } catch {
    profiles = undefined;
  }
  return (
    <div>
      <p>
        Saved guidance applies when BB constructs a new or resumed provider
        session. Running sessions keep their original instructions. The next
        continue or fork assignment carries current worker guidance. Saving
        never restarts or wakes agents.
      </p>
      <p>
        Global fallbacks apply after explicit task, delegation and Initiative
        choices. Reused workers and replacements inherit current native
        settings. Permissions still use the explicit permissionMode parameter.
      </p>
      {profiles ? (
        <table aria-label="Global fallback profiles">
          <tbody>
            {PROFILE_KEYS.map((key) => (
              <tr key={key}>
                <th scope="row">{PROFILE_ROLE_LABELS[key]} <code>{key}</code></th>
                <td>{describeProfile(profiles[key] ?? DEFAULT_PROFILES[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>Global fallback profiles are unavailable.</p>
      )}
      <p>Reset a saved field to its populated default.</p>
      {([
        ["coordinatorInstructions", "coordinator instructions"],
        ["workerInstructions", "worker instructions"],
        ["executionProfiles", "execution profiles"],
      ] as const).map(([field, label]) => (
        <button
          key={field}
          disabled={busy || settings.isLoading}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setReset(null);
            try {
              await rpc.call("resetSetting", { field });
              setReset(`Reset ${label}.`);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Reset {label}
        </button>
      ))}
      {error ? <p role="alert">{error}</p> : null}
      {reset ? <p role="status">{reset}</p> : null}
    </div>
  );
}
