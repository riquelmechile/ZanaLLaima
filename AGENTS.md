# GPT execution instructions for ZanaLLaima

This project is operated by a single GPT host. Do not create external workers or transmit work to other accounts. Use only the tools and native subagent capabilities that are actually exposed in the running host session.

1. Read `zana_profile` before starting. Request `gpt-6-astra` with `max` reasoning and no deliberate model downgrade. Neither this file nor the MCP server can change the selected model. If the required model is reported incompatible, stop and explain the mismatch.
2. Recover any existing mission with `zana_mission_status`. Create a new mission only when there is no active state; write actions require explicit, narrow authorization and an allowlist of paths.
3. Call `zana_next_batch` with a truthful observed host capability report. If the host offers no native subagent launch surface, operate inline. Never invent subagent counts, run IDs or review independence.
4. Use `zana_start_batch` to reserve a safe batch. Execute all returned packets with the host's actual tools. Execute independent read-only packets in parallel only if a real native launch surface exists; otherwise handle them in one host context. Never run concurrent writers in this initial version.
5. On completion, use `zana_complete_unit` with the exact returned token, actual evidence and `success: true` only when the assigned acceptance criteria really pass. Do not treat a tool response or a planned task as evidence of execution.
6. If a write outcome is uncertain, preserve state and stop. Do not silently retry effects. Verification and review are distinct from creating a plan; do not claim independent review without independently executed evidence.
7. Before proposing a merge or deployment, report the exact candidate, completed checks, unresolved risks and required operator approval. Never infer release permission from successful task completion.

Memory, local work state and instructions must remain private to this repository. Avoid unrelated project references, cross-repository tooling and inherited configuration files.

## Candidate-bound four-lens review

When mission units finish and a real Git candidate SHA is available, open a local RDD cycle. Request perspectives for risk, reliability, resilience and readability without choosing external reviewers.

When native subagents are actually available, send independent packets into separate host-native contexts. Never share the sibling reviewers' observations until each has returned. When native subagents are unavailable, use the single-context sequential path; label it a self-check rather than an independent review.

Submit only genuine findings and evidence with the exact frozen SHA and packet token. A changed SHA invalidates previous review evidence. High-severity findings block a passing verdict. Neither a completed solo review nor host-reported native contexts certify independence, Git checks or permission to merge. Respect `approved: false` in the review status.

## Persistent storage

Use `zana_storage_status` to inspect schema and integrity and `zana_storage_history`/`zana_storage_reviews` for paginated, read-only historical evidence. Treat a pending offline restoration as a hard stop. Backup, migration and restoration remain explicit operator-only CLI actions and must not be inferred from a tool result or executed by a model without separate operator authorization. Do not retry uncertain writes automatically.


## Fail-closed lifecycle and signed permissions

Before launching a WRITE, inspect `zana_permission_status` and require a valid separately signed operator approval. Never treat `writesAllowed` in a mission JSON as consent. If the approval is missing, expired or revoked, do not write. Keep the operator signing key outside the model runtime.

Preserve `token`, `leaseGeneration` and `expiresAt` from every reserved unit. Use `zana_unit_heartbeat` to extend only an active lease; never send a completion for a stale or expired claim. Run `zana_recover_expired` on resumption. READ work may be explicitly retried within the bounded limit; interrupted WRITE work must remain `OUTCOME_UNKNOWN` until operator-signed reconciliation proves completion or no effect. Do not infer non-execution from a lost response.

For files under the workspace root, reject symbolic links and recheck permissions at the actual moment of the file operation. The local preflight is not a substitute for a trusted OS-enforced write boundary. Mission close/archive is separate from PR approval and release.

## Phase 2 RDD safety

Use the Git-bound commands in `docs/solo-rdd.md`. Before opening a review, confirm that the local commit and worktree are clean. Do not submit a synthetic SHA or claim an unverified branch, target or Git tree. Check Git again before each review packet and the release decision. Any drift invalidates old packets and requires a newly committed candidate. The verified correction loop is bounded to five rounds.

Never present four reported context IDs as independent verification. Respect the available native capacity, including a fallback to one self-review context when it disappears; do not share other lenses' outputs before completion. A signed CI attestation must come from an external verifier with a separate key, and the operator approval must be signed independently. The delivery gate returns only manual-release readiness and cannot authorize merging or deployment.

## Official MCP SDK and host provenance

The local MCP transport uses the official SDK v2; read [docs/mcp-v2.md](docs/mcp-v2.md). Treat `zana_capability_status.requested` as configuration intent, `hostReported` as an unverified user/host report, and `verified` as independent evidence unavailable until an external authenticated integration exists. Never infer model, effort, context isolation, native launch count, or permissions from a report.

Work with one authenticated host context, complete `READ` tasks, then run the four RDD lenses in solo mode when native subagents cannot truly be launched. Cancellation can arrive after a committed effect: inspect mission state, preserve uncertainty and do not repeat a `WRITE`. Keep MCP on local stdio only; never manufacture an HTTP endpoint, callback or bearer token.

## Phase 5: release and repository governance

Before claiming readiness, require `npm ci`, `npm run release:preflight`, `npm test`, `npm run test:stress`, `npm run test:coverage`, and the security audit on the exact candidate SHA. Verify both required GitHub status checks for all supported Node versions; never treat another commit's green CI as the current HEAD. Check the live GitHub branch rules and approval on the exact SHA using an authorized administrative or reviewer identity. The local preflight cannot verify GitHub rulesets, an independent reviewer, a trusted external CI signature or real executor authorization. No agent can approve its own release and no passing test automatically enables merge or deployment. See `docs/release-security.md`.

## Phase 4: incremental scheduling and budgets

Whenever a READ finishes, check `zana_next_batch` again to refill only available READ slots without waiting for the entire previous batch. Respect the minimum of current host capacity and `mission.budget.maxActiveReads`, capped at four. An available READ slot is **not** evidence of a launched subagent. When the host cannot launch real subagents, operate in a single sequential context and do not overstate throughput.

Never overlap WRITE with another WRITE or READ. If an operator-authorized WRITE is ready, drain existing readers; do not continue refilling to starve the writer. If any WRITE is `OUTCOME_UNKNOWN`, stop until signed reconciliation. The SQLite commit boundary now enforces exclusive writer state and rejects changes to mission budgets. Do not bypass it with direct repository/OS tools.

Budgets cover mission duration, starts, attempts, active reads, lease seconds, result bytes (UTF-8), and verified RDD rounds. Respect the immutable deadline and return `BLOCKED` rather than inventing extensions. Review [docs/phase4-performance.md](docs/phase4-performance.md) and run `npm run benchmark:phase4` for local measurements. The deterministic comparison is not a host-native performance attestation.
