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
