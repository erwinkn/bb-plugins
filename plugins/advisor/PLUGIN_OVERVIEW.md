Watch the threads you choose and keep a factual record of what their agents did: file edits with diffs, commands with exit codes, completion claims, turn ends, and test files changed by shell commands. When you turn reviews on, a tools-less reviewer reads one bounded packet of new evidence and reports material risks, such as a test loosened without a requirement asking for it. Every citation is checked against the exact hunk lines before you see it.

## What you get

- An **Advisor** page with your watched threads, each with Findings, Evidence, Coverage, Requirements and Reviews tabs. It works on desktop and on narrow screens.
- An **Advisor** tab in a thread's side panel to watch that thread and see its findings.
- Findings that show the exact before and after lines, whether the test name was proven from the hunk, the requirement they cite and how that requirement's authority is known.
- Coverage that names what the Advisor could not see: history before the watch, missing diffs, truncated hunks, checkpoint gaps, pruned or skipped evidence, partial requirement context.
- Settings for every behavior it has: watch scope, triggers, cadence, packet and retention bounds, concurrency, route and model, effort, custom instructions, daily budgets, display threshold and notifications. Below the form, the effective state shows errors, which secrets are set, whether the Account Pooler currently lets a pooled route through (and how to turn it on), and what is not available yet.
- `bb advisor status|watch|unwatch|findings` for agents and terminals.

## How it works

Watching only reads. The Advisor pages through the thread's persisted events at most 100 at a time with strict cursors, keeps immutable cards in its own database, and at each turn end snapshots changed test files to catch edits made through the shell. It never sends a message to a watched thread, never changes its files, and never records Initiative decisions.

Reviews are off by default, and so are model provider requests. The deterministic fake reviewer needs no key and makes no request; use **Preview (fake)** to see the whole pipeline on real evidence without spending anything. Real routes are Claude Sonnet 5.5 or GPT-6 Luna through the Account Pooler (subscription quota) or through your own API key (USD), and Jev through a TypeSafe key for test integrity only. Each review sends exactly one request, never retries and never falls back to another model, route or account. Daily caps are reserved before a request, unknown usage is charged in full, and subscription quota is never converted to dollars.

A finding is advisory and never closes itself: passing tests do not resolve a weakened test, and a weakening that returns after a restore is a new alert. "Mark seen" is a local mark, not a review or sign-off. Preview findings are labeled and never change a real finding.

## Requirements

Reviews with a real model need the matching route enabled in Settings, the daily caps, and either the Account Pooler's advisor route switched on or an API key. Initiative context comes from the Projects read-only context routes when they are installed; without them every thread is reviewed as a standalone thread. When that context cannot be read, or the thread is a former Initiative member, no review is sent and the reason is shown.

This plugin is a prototype. Judgment quality and cost per review are unmeasured.
