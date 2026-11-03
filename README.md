# ZanaLLaima

A standalone, GPT-native engineering workspace. One GPT host coordinates an objective, performs its own reasoning and can use **native parallel subagents only when its application actually offers them**. There is no external worker mesh, inference-provider API, shared credentials or required cloud backend.

## Core contract

- **Requested model:** `gpt-6-astra`, reasoning effort `max`, with **no deliberate model fallback**. This is a request; a local process cannot select the ChatGPT model or verify its effective effort.
- **Processing:** standard root tier; prefer fast native branches when available without reducing reasoning effort.
- **Parallel work:** request maximum native capacity, cap each independent batch at four, and process work inline if native subagents are absent. Parallel batches in this initial release are **read-only**. Writes run singly, with explicit authorized paths.
- **Execution:** the GPT application performs all reasoning, file edits, native subagent launches and checks using its real tools. This code **does not** start models or subagents.
- **Truthfulness:** planned parallel work is not evidence that workers launched. Host-reported capabilities, model settings, reviews and results remain unverified until separately attested.
- **Scope:** no remote task sending, no impersonation, no hidden agents, no automatic release actions. PR merges and deployments require separate permission.

## Project roadmap

The prioritized audit backlog, acceptance gates and delivery milestones are in [ROADMAP.md](ROADMAP.md). It tracks planned work only; unchecked items are not implemented.

## Durable storage

The state backend uses SQLite WAL, with conservative migration from existing JSON, real multiprocess transactions, bounded historical reviews, backup and offline restore. See [storage operations](docs/sqlite-storage.md). This does **not** yet recover uncertain running work; the Phase 0 safety gate remains open.

## Components

- `src/core.mjs`: isolated mission DAG, permission gates, capability-aware batch planning, fenced per-unit completion.
- `src/store.mjs`: single-writer local JSON state, atomic replacement and fail-closed lock.
- `src/actions.mjs`: tiny stateful action layer.
- `src/mcp.mjs`: local Model Context Protocol server over standard input/output.
- `src/cli.mjs`: command-line interface for development and inspection.
- `AGENTS.md`: instructions for a host using this project.

This is an initial **local development release**, not a public remote ChatGPT app or an autonomous background agent. Remote connectivity would need its own security and OAuth design. Node.js 22+ is required; there are no npm runtime dependencies.

## Try it locally

```bash
npm run check
npm test
npm run cli -- profile
npm run cli -- init examples/mission.json
npm run cli -- next examples/host-report.json
npm run cli -- start examples/host-report.json
npm run cli -- status
```

`start` reserves all units in the planned safe batch in a **single local state transaction**, returning a distinct token and instruction packet for each. A compatible GPT host may run independent packets concurrently with its native subagent tools. To finish a unit after actually doing the work:

```bash
node src/cli.mjs complete <unit-id> <run-token> actual-outcome.json
```

Each result must contain `success` (boolean), a factual `summary` and a nonempty list of `evidence`. The JSON in `examples/outcome.json` is **illustrative only**, not a valid substitute for actual checks. Use `ZANA_STATE_FILE=/safe/path/state.json` to select a separate state file. The default is `.zana/state.json`, which is ignored by Git. Only one active mission per state file is supported initially.

## Connect to a local MCP-compatible host

Start the local transport with `npm start` or configure the client command `node /absolute/path/to/ZanaLLaima/src/mcp.mjs`. The MCP exposes 15 local tools: 12 for missions and four-lens review, plus read-only `zana_storage_status`, `zana_storage_history`, and `zana_storage_reviews`. Storage migration, backup and restore are operator-only CLI commands, not MCP tools. All use local files and the authenticated capabilities of the *calling application*, not an API key stored here.

The MCP adapter is **stdio-only** and assumes a trusted local operator. Do not expose it as an unauthenticated HTTP endpoint. ChatGPT web app integration and real subagent launch must be tested separately on a host that supports those features.

## Storage operator commands

Use `node src/cli.mjs storage-status` for integrity and schema status; `storage-history 25` and `storage-reviews 25` for paginated data. To migrate a legacy JSON state, stop other clients and execute `storage-migrate`. For an SQLite-consistent backup run `storage-backup /new/backup.sqlite`. Restoring a backup requires all clients stopped and `ZANA_RESTORE_OFFLINE=1 node src/cli.mjs storage-restore /backup.sqlite`. Review [the operational precautions](docs/sqlite-storage.md) first.

## Verification

`npm run check` validates the Node modules. `npm test` covers permissions, cycles, model mismatch, parallel read batches, serialized writes, stale tokens, lock behavior and MCP handshake. A passing CI run verifies those code paths, not the real model configuration or actual native subagent fanout.


## Single-account RDD

After all mission units are complete, freeze the exact Git candidate and run a four-lens review. The same GPT can handle all lenses sequentially, or the host may launch up to four genuinely available native contexts. The local control plane prepares packets but never launches agents itself.

```sh
node src/cli.mjs review-open $(git rev-parse HEAD)
node src/cli.mjs review-next
node src/cli.mjs review-start
node src/cli.mjs review-status
```

Use `review-submit` with exact lens ID, packet token, candidate SHA and actual evidence. Check for candidate changes using `review-check`. A complete self-review is **not an independent approval**; host-reported native review is also unverified. Both always report `approved: false`. See [the local review contract](docs/solo-rdd.md).
