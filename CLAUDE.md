# grok-plugin-cc

Claude Code plugin that delegates tasks and code reviews to the xAI Grok CLI.
Forked from openai/codex-plugin-cc; the Codex app-server/broker layer was replaced
with headless Grok invocations.

## Architecture

- `plugins/grok/scripts/grok-companion.mjs` — CLI entry (setup, review,
  adversarial-review, task, task-worker, status, result, task-resume-candidate, cancel).
- `plugins/grok/scripts/lib/grok.mjs` — transport: spawns
  `grok --single <prompt> --output-format streaming-json` per turn.
  Resume = `--resume <sessionId>` (Grok session id stored as job `threadId`).
  Read-only runs add `--deny Write --deny Edit --deny Bash`; write runs use headless
  defaults (which do write files). Structured review output via `--json-schema`.
  Streaming events: `thought`, `text`, `end {stopReason, sessionId, requestId}`;
  success = stopReason EndTurn/MaxTokens, regardless of exit code (denials exit 2).
- `plugins/grok/scripts/stop-review-gate-hook.mjs` — optional Stop hook
  (`/grok:setup --enable-review-gate`). Only hook; the upstream session-lifecycle
  hook was broker-only and is deleted.
- Job state per workspace under `CLAUDE_PLUGIN_DATA` (fallback tmpdir), managed by
  `lib/state.mjs` / `lib/job-control.mjs` / `lib/tracked-jobs.mjs`.

## Removed vs upstream

app-server broker (all of it), `transfer` command, gpt-5-4-prompting skill,
native reviewer path (both review commands share `prompts/adversarial-review.md`
with a `{{REVIEW_KIND}}` switch), npm prebuild/build (app-server type generation).

## Dev

- `npm test` — node --test, includes fake-grok transport tests
  (`tests/grok-transport.test.mjs`, override binary with `GROK_COMPANION_BINARY`).
- Efforts: low|medium|high. Model alias: `composer` → grok-composer-2.5-fast.
- Version bumps: `npm run bump-version` (syncs package.json, plugin.json,
  marketplace.json).
