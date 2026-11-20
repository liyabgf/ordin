# Ordin

[中文](README.md) | English

Ordin is a local task coordinator. Discuss an idea in chat, then explicitly ask Ordin to carry out work. It records conversations and tasks and brings progress, reports, decisions, and deliverables together in a task workspace.

> **Development preview.** The panel, settings, and task records can run independently. Running work requires a configured DSH, Codex, or Claude Code backend. Offline tests and controlled browser checks do not establish production readiness for every provider, chat channel, or long-running scenario.
>
> Ordin is a standalone task coordinator that grew out of the earlier myagent DSH plugin. The chat bridges migrated from that project are maintained in Ordin. [Original dsh-myagent repository](https://github.com/liyabgf/dsh-myagent)

## What you can do

- **Discuss, then delegate:** ordinary conversation does not create a task. When an explicit request creates a task, its card appears in the conversation. If a send result is unknown, read the conversation and task history before deciding whether to retry.
- **Track work:** see the task state, recorded execution backend, latest recorded progress event, successful refresh time, reports, and deliverables. Waiting for a backend, waiting for your input, recovery that needs review, and unavailable progress are shown as distinct conditions.
- **Configure connections:** configure Ordin's conversation model separately from execution backends. A connection version identifier helps compare the current setting with the version recorded on a task. Saving a new connection does not migrate a running turn; a later start or continuation is prepared using the configuration then in effect.
- **Manage reusable assets:** import and browse documents, datasets, reports, code, and references. Assets are labeled available, pending review, or archived. A task can pin a specific version. Delivery to a backend does not prove that it read or used the asset.
- **Review delivery states:** a draft selection, a saved input awaiting delivery, a delivered input, and an input not delivered before task end are distinct states. Asset availability and task acceptance are separate.
- **Organize work and connect sources.** Create tasks directly, schedule recurring work, and browse work, project, and record views. Ordin also accepts inbox files, API requests, rules, and separately configured chat bridges. [Chat bridge setup](bridges/README.md)
- **Manage memory and skills.** Candidate memories require user confirmation. Select enabled skills and pin their versions for a task.
- **Run locally:** the panel remains available when no execution backend is configured. Protected offline commands can back up and restore the SQLite database.

## Start

Requirements: Node.js 24.9 or later and the project dependencies. You do not need to start an execution backend before launching Ordin.


Clone and start with npm:

```bash
git clone https://github.com/liyabgf/ordin.git
cd ordin
npm ci
npm start
```

Or use pnpm:

```bash
pnpm install --frozen-lockfile
pnpm start
```

Open the address printed in the terminal. The default is `http://127.0.0.1:7471/ordin/`. Press Ctrl-C to stop the service. The management panel is intended for trusted local use.

## Run your first task

1. Configure and test the conversation model in Settings, then check the execution backend you plan to use.
2. Intake defaults to `observe`, which only records requests. Switch to `auto` to let tasks that pass intake checks run.
3. Open the chat from the home page and describe the work and deliverable you want. When a task is created, open its card to follow progress.

## Conversation model

In **Settings → Ordin model**, select OpenAI, DeepSeek, or another OpenAI Chat Completions-compatible service. Enter its URL, model, and API key, then test the connection. The key is stored in a separate local credentials file with mode 0600 and is never displayed by the panel. A supported environment variable can be used instead; a locally saved key takes precedence. The Anthropic native API is not currently supported.

Ordin's conversation model and DSH's own model credentials are independent. Do not put API keys or service tokens in task text, source control, or shell history.

## Execution backends

Use **Settings → Execution connections** to check or connect a local backend. Availability depends on the program being installed and logged in, or its service running. DSH service mode uses DSH's own permission configuration. Codex and Claude Code use their respective local installations and login states.

As of this version: Codex has completed a real task acceptance; DSH is connected through service mode with a service URL and token; Claude Code is supported but needs a local account login and has not been accepted yet.

Ordin reports execution receipts and task acceptance separately. Received, started, or delivered does not mean completed. A connection ID identifies a local connection configuration version; it contains no credential. Historical tasks without a recorded ID are shown as unknown.

## Assets and deliverables

Asset references pin a version and content hash so the selected material can be identified later. “Delivered” means Ordin received a delivery receipt from the backend; it does not prove that the backend read, understood, or successfully used the material. Inputs that were not delivered before task end are labeled accordingly.

If a network error occurs during a write, the server may already have applied it. The panel keeps the user's input, marks the result as uncertain, and asks the user to refresh and inspect the current state before deciding what to do next. It does not automatically repeat the write.

## Data and backups

By default, state, work, and inbox directories are under `~/.ordin`. Override them with `ORDIN_STATE_DIR`, `ORDIN_WORK_ROOT`, and `ORDIN_INBOX_DIR`. Do not publish databases, task content, work files, or credentials from those directories.

Stop Ordin before an offline database backup or restore. Specify absolute paths:

```bash
node --experimental-transform-types src/index.ts storage backup --state-dir /absolute/path/to/state --output /absolute/path/to/ordin.sqlite3
node --experimental-transform-types src/index.ts storage restore --state-dir /absolute/path/to/state --input /absolute/path/to/ordin.sqlite3
```

The maintenance commands handle the SQLite database only. Back up work files and credentials separately. Restore refuses to proceed if the service still holds the state lock, the input is incomplete, or SQLite sidecars are unsafe. Do not change the schema version manually to roll back.

## Current limitations

- Offline tests and isolated Chrome checks cover controlled product paths; they do not prove that a real provider call will succeed with your credentials or network.
- The latest panel verification covered desktop, 390-pixel layout, keyboard focus, the accessibility tree, CSS zoom, and narrow-screen reflow. Native browser zoom, human screen-reader use, every provider, and every chat channel still need separate validation.
- Progress is based on recorded events and has a bounded history window. If history is incomplete, progress is marked incomplete or unknown. Universal real-time token streaming is not guaranteed.
- Text preview is subject to backend read limits. Other formats use the supported download or preview path; embedded rendering is not guaranteed for every format.
- Controlled model and worker fixtures validate the application flow, not the quality of model output or the correctness of every automatic acceptance decision.

## Development checks

```bash
npm run typecheck
npx vitest run --maxWorkers=1 --no-file-parallelism
```

See [architecture](docs/03-architecture.md), [functional execution plan](docs/33-functional-execution-plan.md), [migration plan](docs/10-migration-plan.md), and [security boundaries](SECURITY.md).
