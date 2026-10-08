See where your tokens go: cost, cache hit rates and quota, by hour or day, model,
account, role, project, Initiative and thread.

## What you get

- A **Usage** page in the sidebar with totals, cost over time, breakdowns,
  cache and warming savings, errors, and each account's quota history.
- Filters for range, provider, model, account, role, project and Initiative;
  click a table row to filter by it, or a thread to open it.

## How it works

The numbers come from the Account Pooler's request ledger, read over its
read-only RPCs. Thread titles, projects and Initiatives come from BB. Nothing
leaves the machine.

## Requirements

The Account Pooler (`account-pool-local`) must be installed and recording
usage. Initiatives is optional.
