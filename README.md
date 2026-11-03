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

## Safe mission lifecycle (Phase 0)

A write request inside a mission is **not** permission to modify files. Reserving a `WRITE` requires a valid, unexpired Ed25519 operator-signed approval, a configured local workspace root and a scoped path inspection. The operator's **private key must never be placed in this repository or provided to the model**. Only local CLI can import signed operator decisions. A cancelled mission revokes active grants.

Read-only work can be recovered from expired leases and retried deliberately with fresh fencing tokens. An interrupted write transitions to `OUTCOME_UNKNOWN` and **cannot be replayed without a separate signed reconciliation based on actual evidence**. Close and archive completed or cancelled missions before starting the next mission. See [the recovery and security contract](docs/safety-lifecycle.md).

The local planner cannot enforce file mutations by external host tools; host integration must apply the same controls at the actual effect boundary before production use.

## Phase 2: Git-bound four-lens review

After all mission tasks are DONE, configure the local worktree with `ZANA_REVIEW_REPO=/absolute/path/to/repo` and an optional `ZANA_REVIEW_TARGET_REF=refs/heads/main`. The local controller independently checks the actual Git commit, tree, branch, target-base and clean worktree. Client-supplied SHA values are rejected if they differ from Git. Dirty or changed candidates invalidate outstanding review packets.

```sh
node src/cli.mjs review-open "$(git rev-parse HEAD)"
node src/cli.mjs review-next [host.json]
node src/cli.mjs review-start [host.json]
node src/cli.mjs review-status
node src/cli.mjs review-check
node src/cli.mjs delivery-check ci-attestation.json operator-approval.json
```

Native 4R uses at most the host-reported context capacity, capped at four; if it disappears, remaining reviews fall back to a single context and are labeled self-checks. No mode claims independently verified subagents. Up to five verified candidate rounds are permitted per mission.

The **delivery gate** requires both a separately signed CI attestation and a separately signed operator decision in addition to a clean, unchanged Git candidate and passing review lenses. Its highest result is `READY_FOR_MANUAL_RELEASE`: it **never** authorizes or performs merge/deploy. CI signatures are tested locally with temporary keys; authentic CI receipt production and GPT-host integration remain scheduled for later. See [the RDD security contract](docs/solo-rdd.md).

## Durable storage

The state backend uses SQLite WAL (schema v3), with conservative JSON migration, fenced concurrent writes, persistent review correction rounds, bounded histories, backup and offline restore. See [storage operations](docs/sqlite-storage.md). Expired READ work has controlled retries; uncertain WRITE work still requires separate operator reconciliation.

## Components

- `src/core.mjs`: isolated mission DAG, permission gates, capability-aware batch planning, fenced per-unit completion.
- `src/store.mjs`: transactional SQLite WAL state, migration, receipts, audit history and archival.
- `src/git-evidence.mjs`: trusted local Git HEAD/tree/branch/cleanliness observation.
- `src/review.mjs`: adaptive, candidate-bound four-lens review engine.
- `src/delivery.mjs`: separately signed CI/operator attestation gate, without release actions.
- `src/actions.mjs`: tiny stateful action layer.
- `src/mcp.mjs`: local Model Context Protocol server over standard input/output.
- `src/cli.mjs`: command-line interface for development and inspection.
- `AGENTS.md`: instructions for a host using this project.

This is an initial **local development release**, not a public remote ChatGPT app or an autonomous background agent. Remote connectivity would need its own security and OAuth design. Node.js 22.16+ is required; runtime dependencies are pinned to `@modelcontextprotocol/server` and `zod`; install with `npm install --ignore-scripts --no-audit --no-fund`.

## Try it locally

```bash
npm install --ignore-scripts --no-audit --no-fund
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

Each result must contain `success` (boolean), a factual `summary` and a nonempty list of `evidence`. The JSON in `examples/outcome.json` is **illustrative only**, not a valid substitute for actual checks. Use `ZANA_STATE_FILE=/safe/path/state.json` to select a separate state file. The default is `.zana/state.json`, which is ignored by Git. Only one active mission per state file is supported; close/archive the prior mission before starting the next.

## Phase 3: official MCP SDK and capability provenance

The MCP server is implemented using [the official TypeScript SDK v2](docs/mcp-v2.md), with protocol 2026-07-28 support and a verified local legacy handshake for 2025-11-25. The client-side automated test launches a genuine SDK stdio server process and completes a READ mission followed by sequential four-lens review. The test **does not involve a model**.

Call `zana_capability_status` to distinguish `requested`, `hostReported`, and `verified`. The latter is intentionally `NOT_OBSERVED` until a real host provides independent authenticated evidence. Never pass a claimed verification flag through a host report and treat it as proof.

Remote transport, OAuth, actual host model verification, and native subagents remain deferred. Local stdio has no public URL or bearer token. SDK cancellation is cooperative: inspect persisted state after lost calls before attempting any retry.

## Connect to a local MCP-compatible host

Start the local transport with `npm start` or configure the client command `node /absolute/path/to/ZanaLLaima/src/mcp.mjs`. The MCP now exposes **23 local tools** through the official TypeScript SDK v2 over stdio, including `zana_capability_status`. The SDK validates requests, negotiates the protocol and returns recoverable `isError` tool results. The server still does not connect to ChatGPT or launch real subagents. Signed operator actions, backup, restore and archival remain CLI-only operations. Storage migration, backup and restore are operator-only CLI commands, not MCP tools. All use local files and the authenticated capabilities of the *calling application*, not an API key stored here.

The MCP transport is **stdio-only** and assumes a trusted local operator. Do not expose it as an unauthenticated HTTP endpoint. ChatGPT web app integration and real subagent launch must be tested separately on a host that supports those features.

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
