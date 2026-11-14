<p align="center">
  <img src="assets/brand/zanallaima.svg" alt="ZanaLLaima, a nerdy carrot with glasses" width="190">
</p>

<h1 align="center">ZanaLLaima</h1>

<p align="center"><b>A development harness for the ChatGPT app.</b><br>
GPT codes, tests and reviews on GitHub with no terminal: a remote MCP sets the rules and GitHub has the final word.</p>

<p align="center">
  <a href="README.md"><img src="assets/brand/lang-es.svg" alt="Español" height="36"></a>
  &nbsp;
  <a href="README.en.md"><img src="assets/brand/lang-en-active.svg" alt="English (current)" height="36"></a>
</p>

---

> **Hi, I'm ZanaLLaima.** I'm a nerdy carrot with glasses, and honestly, I don't trust anything that hasn't gone through my four lenses: risk, readability, reliability and resilience. I don't call any model and I don't have a shell. I just let GPT work where it should, let the tests decide and make the review sign the exact SHA. If anything changes at the last second, I don't merge. 🥕🤓

## What is it?

- **A remote MCP** that plugs into the ChatGPT app as a connector, with OAuth and closed registration. It runs on your own server, behind an HTTPS tunnel (for example Cloudflare Tunnel).
- **A complete harness for a single GPT.** It organizes the mission into units with a budget. GPT writes code **only** on its mission branch (it can also edit and comment on its PR and trigger the checks), the tests run in GitHub Actions, and the 4R review is done by the same GPT in **another conversation**.
- **An honest delivery gate.** The review is published by a GitHub reviewer account (separate from the author) on the exact SHA, and `zana_merge` merges only when everything is green on that same SHA.

## Architecture

<p align="center">
  <img src="assets/diagrams/arquitectura.en.svg" alt="Architecture: the ChatGPT app connects over MCP and OAuth to ZanaLLaima on your server; ZanaLLaima uses the official GitHub MCP to write only to the mission branch, GitHub Actions runs the tests and the reviewer account signs the review." width="100%">
</p>

**The truth is the SHA on GitHub and its checks.** The author and reviewer tokens live only on the server: never in the repo, in logs or in tool results.

## How it works

<p align="center">
  <img src="assets/diagrams/flujo.en.svg" alt="Workflow: the author conversation creates the mission, commits to the branch and opens the PR, waits for green checks, completes the unit and requests a ticket; a new reviewer conversation claims the ticket, reads the full diff, runs the four lenses and finalizes; GitHub receives the signed review and zana_merge merges with the exact SHA." width="100%">
</p>

1. **Author conversation.** GPT loads the `zana-odd` skill and creates the mission (`github: {repo, base}`).
   - While the code unit is `RUNNING`, it writes **only** through `zana_ds_github` and **only** to `zana/<missionId>`.
   - It opens the PR and runs the checks until they are green: one Actions run per finished SHA, not one per commit.
   - Then it **completes the unit**, and only after that requests a ticket with `zana_review_request`. While a code unit is still `RUNNING`, that call returns `UNIT_STILL_RUNNING`.
2. **Reviewer conversation (new).** You paste "Review ticket ZR-… with ZanaLLaima".
   - That session claims the ticket. It cannot be the author, it cannot have written anything and it must be newer than the ticket.
   - It is read-only and reads every page of the diff.
   - It runs the 4 lenses with `zana-4r` and finalizes.
3. **Delivery.** ZanaLLaima re-reads the PR head.
   - If it moved, the result is `STALE_SHA`.
   - Otherwise it publishes the review signed by the reviewer account plus the `zana/4r` status.
   - `zana_merge` merges with `sha` set to the verified head.
   - If the review requested changes, `zana_correction_start` opens a correction unit and the cycle repeats with a new ticket.

## What it guarantees and what it doesn't

| Guarantees | Does not prove |
| --- | --- |
| The reviewer session differs from the author, has no durable writer mark or recorded authorship, and reviewed **that** SHA with the full diff and green CI | What was discussed in the chat or actual independence: a persistent reviewer must only review; the host reports model and context |
| GPT cannot write to `main` or `.github/workflows`, or merge through the downstream | That the reviewer is a different ChatGPT account. With `ZANA_DISTINCT_REVIEWER_CLIENT=true` it only proves a different OAuth client; a different account depends on which clients the operator registers |
| A SHA with requested changes cannot be approved again without changing the code | That the separation holds for a client that does not send the conversation id: without it, every connection counts as a new session (see [docs/solo-rdd.md](docs/solo-rdd.md)) |

## How to set it up

The full guide, from scratch, is in **[docs/deploy-remote.md](docs/deploy-remote.md)** (in Spanish). In short:

1. **Two GitHub accounts.** The author, with a fine-grained token limited to your repos, and a reviewer that only publishes reviews. The exact permissions are in the guide.
2. **Each managed repo** gets the checks workflow ([docs/checks-workflow.md](docs/checks-workflow.md)), which runs only when ZanaLLaima asks for it, and a protected default branch.
3. **A Linux server** with Node.js ≥22.16: clone, `npm ci`, fill in `zanallaima.env` (outside the repo, `chmod 600`) and run it as a `systemd --user` service.
4. **An HTTPS tunnel** (Cloudflare Tunnel or another proxy) that publishes `https://<your-domain>/mcp`.
5. **In ChatGPT**, with developer mode on, create the connector with that URL and OAuth while the enrollment window is open (`node src/cli.mjs remote-enroll 15`).

Your real values (domain, accounts, tokens and operator password) live **only** in the server's environment file. The repo ships none of them as defaults: without `ZANA_PUBLIC_HOST` and `ZANA_REVIEWER_LOGIN` the server does not start.

## Project status

**Version 0.9.0, alpha.** This is experimental software for **one instance per operator**. Remote mode has been in real use since November 9, 2026; the project capabilities marked as observed were used live on November 12, 2026.

| Component | Status |
| --- | --- |
| Remote mode: HTTP with sessions, OAuth with closed registration, `/health` | In real use, behind an HTTPS tunnel |
| Session per conversation | Observed: ChatGPT opens a new connection on almost every tool call, so the session follows the conversation, not the connection |
| GitHub MCP downstream and allowlist policy (v2.1.0) | In real use against the official GitHub MCP |
| Checks, tickets, lenses, review by the reviewer account, delivery and merge | In real use: 3 complete missions. In one, the reviewer conversation found a critical bug, requested changes, and another conversation approved the fix |
| Per-project memory, PR size limits and bounded correction rounds | Implemented and tested; in use |
| Project interview, plan with alternatives and per-client drafts (`zana_discovery_*`, `zana_project_plan_draft`, `zana_workspace_*`) | Deployed and tested by the operator on November 11, 2026. They are drafts: they create no repositories and authorize nothing |
| MCP Apps approval panel | Observed in real use since November 12, 2026: one operator click in ChatGPT approved the plan and authorized the repository |
| Operator plan approval (`zana_plan_approval_request`, `zana_plan_approval_status`, `/operator/approve` page) | Fallback when the client does not display panels: the decision is made on the server page with operator authentication |
| Repository creation (`zana_bootstrap_execute`) | Observed in real use since November 12, 2026: the first repository created this way was a real operator project |
| Optional full GitHub access for the orchestrator (`zana_github_request`, `ZANA_GITHUB_FULL_ACCESS`) | Observed in real use: GPT configured CI and branch protection on the new repository |
| Automatic 4R through `zana.review.ready` | Observed in real use: the host monitor woke a new run, claimed the ticket without a `ZR-` code, and published a review that requested changes, without manually opening a conversation |
| `zana.review.done` and `zana_mission_adopt` | Implemented, tested and deployed with 0.9.0; not yet observed live. The lease lasts `claimTtlMinutes` (240 min by default) and belongs only to the latest adoption |
| `project-orchestrator`, `project-review-delegation`, `project-delivery` and `project-events` | Tested contracts with no tool executing them; no `src/` module imports them. The milestone orchestrator is not connected: the `zana-project-orchestrator` skill resumes the mission with mission tools |
| Per-repository CI (`ZANA_REPO_CHECKS_JSON`) and account-wide allowed repositories (`owner/*`) | Implemented and tested |
| One Actions run per SHA | Observed: a mission with one CI fix and one review correction round used 3 runs, one per SHA |
| Live negative cases (the reviewer tries to write, the author claims its own ticket, a push after the ticket) | Tested against fake servers; **not observed live** |
| SQLite WAL, leases, retries and recovery | Implemented and tested |
| Local stdio mode, `zana_apply_write`, local RDD with `git-evidence`, Ed25519 grants | Implemented; **frozen** after the change of direction |

What this version is **not**: a security audit or a certified product. The 4R review is done by the same model in another conversation, and the model and subagents the host declares are its word. The limits are in [SECURITY.md](SECURITY.md) and [docs/release-security.md](docs/release-security.md).

## Documentation

The detailed documents are in Spanish.

| Topic | Document |
| --- | --- |
| **Step-by-step installation** (accounts, tokens, server, tunnel, connector) | [docs/deploy-remote.md](docs/deploy-remote.md) |
| Tools per mode and transport | [docs/mcp-v2.md](docs/mcp-v2.md) |
| GitHub MCP, policy and the real tool list | [docs/downstream-github.md](docs/downstream-github.md) |
| Checks workflow for managed repos | [docs/checks-workflow.md](docs/checks-workflow.md) |
| Review, tickets and what session separation proves | [docs/solo-rdd.md](docs/solo-rdd.md) |
| Real E2E with the ChatGPT app (ZL-018) | [docs/host-e2e-remote.md](docs/host-e2e-remote.md) |
| Functional safety, states and recovery | [docs/safety-lifecycle.md](docs/safety-lifecycle.md) |
| CI audit, repository security and release | [docs/release-security.md](docs/release-security.md) |
| MCP Apps approval panel | [docs/approval-panel.md](docs/approval-panel.md) |
| Optional full GitHub access | [docs/github-full-access.md](docs/github-full-access.md) |
| Permanent review and continuity monitors | [docs/monitores.md](docs/monitores.md) |
| Roadmap and changelog | [ROADMAP.md](ROADMAP.md) · [CHANGELOG.md](CHANGELOG.md) |

<details>
<summary><b>For developers: requirements, modules and commands</b></summary>

### Requirements

Node.js ≥22.16, Linux for descriptor-anchored write effects, Git, and the dependencies pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run release:preflight
```

CI runs on Node 22.16.0, 22.23.4 and 24, with multi-process stress, coverage (≥80 % branches per module) and a dependency audit.

### Modules

- **Remote:**
  - `src/http.mjs`, `src/oauth.mjs`, `src/remote.mjs`: Streamable HTTP with sessions, OAuth with closed registration, and the 50 remote tools.
  - `src/downstream.mjs`, `src/github-policy.mjs`, `src/github-api.mjs`: GitHub MCP gateway, allowlist and REST client with a breaker.
  - `src/checks.mjs`, `src/remote-review.mjs`, `src/github-delivery.mjs`, `src/skills.mjs`: Actions checks, tickets and paged diff, delivery and merge, skills.
  - `src/remote-state.mjs`, `src/remote-config.mjs`, `src/deadline.mjs`, `src/redact.mjs`, `src/actor-assertion.mjs`: sessions, audit and retention, configuration, per-tool deadlines, secret redaction and actor assertion.
- **Core:**
  - `src/core.mjs`, `src/lifecycle.mjs`: unit DAG, claims, heartbeat, expiry and recovery.
  - `src/store.mjs`, `src/budget.mjs`: SQLite WAL, state, attempts, history, receipts and budgets.
- **Local mode (frozen):**
  - `src/mcp.mjs`: the official MCP server in stdio mode.
  - `src/write-effect.mjs`, `src/write-operations.mjs`, `src/review.mjs`, `src/git-evidence.mjs`, `src/delivery.mjs`: write effects, local RDD and the manual gate.

### Local stdio mode (frozen)

```sh
export ZANA_STATE_FILE=/secure/path/zana/state.json
export ZANA_WORKSPACE_ROOT=/absolute/path/to/workspace
export ZANA_REVIEW_REPO=/absolute/path/to/repo
export ZANA_REVIEW_TARGET_REF=refs/heads/main
node src/mcp.mjs
```

In stdio mode the server exposes 24 MCP tools, and `tests/sdk-mcp.test.mjs` checks the catalog against that number. Remote mode exposes 50 (see [docs/mcp-v2.md](docs/mcp-v2.md)). Storage administration (restore, adopt, cleanup) remains operator-only CLI: [docs/sqlite-storage.md](docs/sqlite-storage.md). The guide for the human steps is [docs/operator-checklist.md](docs/operator-checklist.md).

</details>

---

<p align="center"><sub>ZanaLLaima makes no calls to model providers: the connected host brings the model and ZanaLLaima brings the rules. 🥕</sub></p>
