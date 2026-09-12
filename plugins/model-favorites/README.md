# Model favorites

Star models and re-apply them from a star button in the BB composer.

## What it does

- Adds a **star action** to thread, queued-message, and side-chat composers.
  The popover lists starred models first, then the thread provider's full
  catalog. Clicking a model sets it on the thread with `threads.update`, so
  it applies on the next and later turns without restarting active work.
- Stars are stored per provider **and** model. A thread keeps the provider
  it was created with, so favorites for other providers stay visible but
  cannot be applied there.
- A favorite can pin a reasoning level. Without one, applying keeps the
  thread's current level when the model supports it, else the model's
  default.
- The **Settings → Model favorites** section adds and removes favorites,
  using BB's own provider/model/reasoning picker on the primary machine.
- `bb model-favorites list [--json]` prints the list for agents and
  debugging.

## Limits

- Composer actions render in the trailing cluster before voice/submit; the
  SDK offers no placement option, so the star cannot sit next to the model
  picker on the left.
- The new-thread composer's draft provider/model selection is not reachable
  through the plugin SDK, so the star button does not appear there. Starring
  a model for *new* threads is only possible through Settings.
- `threads.update` accepts `model` and `reasoningLevel` only; permission
  mode and service tier are unchanged by applying a favorite.
- Catalogs resolve on the thread's environment host (or the primary machine
  for Settings). A favorite starred against one host's catalog applies by
  model id wherever the provider resolves it.

## Develop

```sh
cd plugins/model-favorites
npm ci --include=dev
npm run typecheck
npm test
npm run build
```
