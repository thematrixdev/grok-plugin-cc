# Grok plugin for Claude Code

Use Grok from inside Claude Code for code reviews or to delegate tasks to Grok.

Forked from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), rewired to
drive the xAI Grok CLI in headless mode (`grok --single ... --output-format streaming-json`)
instead of the Codex app-server protocol.

## What You Get

- `/grok:review` for a read-only Grok review of your current work
- `/grok:adversarial-review` for a steerable challenge review with custom focus text
- `/grok:rescue`, `/grok:status`, `/grok:result`, and `/grok:cancel` to delegate work and manage background jobs
- `grok:grok-rescue` subagent that forwards substantial tasks to Grok
- Optional stop-time review gate (`/grok:setup --enable-review-gate`)

## Requirements

- **Grok CLI** installed and signed in (`grok` on PATH, credentials in `~/.grok/auth.json`)
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```
/plugin marketplace add thematrixdev/grok-plugin-cc
```

Install the plugin:

```
/plugin install grok@thematrixdev
```

Reload plugins, then run:

```
/grok:setup
```

`/grok:setup` checks Node, the Grok CLI, and cached credentials, and reports what is
missing. Add `--enable-review-gate` / `--disable-review-gate` to toggle the stop-time
review gate for the current workspace.

## Usage

### `/grok:review`

Read-only review of uncommitted changes, or a branch against a base with `--base <ref>`.
Supports `--wait` and `--background`. Output is structured (verdict, findings with
severity and file/line, next steps), enforced with Grok's `--json-schema`.

```
/grok:review
/grok:review --base main
/grok:review --background
```

### `/grok:adversarial-review`

Same targeting as `/grok:review`, plus free-form focus text to pressure-test specific
risks. Runs an adversarial variant of the same reviewer prompt.

```
/grok:adversarial-review challenge whether this caching design is right
/grok:adversarial-review --base main look for race conditions
```

### `/grok:rescue`

Hands a task to Grok through the `grok:grok-rescue` subagent. Supports `--background`,
`--wait`, `--resume`, `--fresh`, `--model <model|composer>`, `--effort <low|medium|high>`.

```
/grok:rescue investigate why tests started failing
/grok:rescue --resume apply the top fix from the last run
/grok:rescue --model composer --effort low fix the lint errors
/grok:rescue --background rewrite the flaky integration test
```

Notes:

- Rescue runs are write-capable by default; reviews are always read-only (enforced with
  `--deny Write --deny Edit --deny Bash`).
- `composer` is an alias for `grok-composer-2.5-fast`; any other model id is passed
  through to `grok --model`.
- Without `--model`/`--effort`, Grok uses its own defaults.
- `--resume` continues the most recent tracked task for this repository as a real Grok
  session (`grok --resume <session-id>`), so Grok keeps its full context.

### `/grok:status`, `/grok:result`, `/grok:cancel`

Manage background jobs: check progress, fetch the stored result, or cancel a running
job. `status` also prints each job's Grok session id with a ready-made
`grok --resume <session-id>` command if you want to continue the conversation in the
Grok CLI directly.

### Stop-time review gate

`/grok:setup --enable-review-gate` makes Claude Code run a Grok review of the previous
turn before it is allowed to stop. Disable with `--disable-review-gate`.

## How It Works

Each turn spawns one headless Grok run
(`grok --single <prompt> --output-format streaming-json`); there is no long-lived
broker process. Continuation maps to Grok CLI session resume. Job records (status,
progress, results, session ids) are stored per workspace under Claude's plugin data
directory, with a temp-directory fallback.

## Development

```
npm test
```

Transport tests stub the CLI via the `GROK_COMPANION_BINARY` environment variable, so
the suite runs without a real Grok login. Version bumps: `npm run bump-version`.
