# Chatre agent harness — architecture notes

Building a production-grade coding agent requires decoupling the underlying AI model from the operating system via a secure, stateful runtime. This note is the blueprint we keep in mind for Chatre: harness loop, instructions, tools, and multi-layer context.

## 1. The harness (execution loop)

The harness is an asynchronous orchestration loop that prevents infinite execution through deterministic token, cost, and iteration boundaries.

```
                  ┌──────────────────────────────┐
                  │   User Input / Workspace     │
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
             ┌─────►│  1. Reason (Planner)    │◄──────┐
             │      └────────────┬────────────┘       │
             │                   │                    │
             │                   ▼                    │
             │      ┌─────────────────────────┐       │
             │      │  2. Decide (Tool Call)  │       │
             │      └────────────┬────────────┘       │
             │                   │                    │
             │                   ▼                    │
Iterate      │      ┌─────────────────────────┐       │ Feedback
Loop         │      │   Sandbox Guardrails    │       │ Loop
             │      └────────────┬────────────┘       │
             │                   │ (If Allowed)       │
             │                   ▼                    │
             │      ┌─────────────────────────┐       │
             │      │  3. Execute (Tools)     │       │
             │      └────────────┬────────────┘       │
             │                   │                    │
             │                   ▼                    │
             │      ┌─────────────────────────┐       │
             └──────┤  4. Observe (Context)   │───────┘
                    └────────────┬────────────┘
                                 │ (On Completion / Max Depth)
                                 ▼
                    ┌─────────────────────────┐
                    │    Generate Patch/Diff  │
                    └─────────────────────────┘
```

### ReAct implementation

1. **Reason (Thought)** — Parse context; form a structural plan.
2. **Decide (Action)** — Select a tool; construct a structured JSON payload.
3. **Execute (Observation)** — Harness validates permissions, runs in an isolated environment, captures stdout/stderr.
4. **Refine** — Append the observation to message history and restart evaluation.

### Critical fail-safes

- **Max iteration ceilings** — Hard stop (e.g. ≤30 tool steps per request) to kill infinite debug loops.
- **Context token compaction** — Clip huge command output; optionally LLM-summarize error stacks before re-injecting history.
- **Light chat vs agentic** — Greetings / answer-only turns must **not** enter the tool loop, seed build todos, or write STRATEGY.md. Composer mode `agent` must not upgrade pure chat to `build`.
- **Delivery completeness** — One `write_file` ≠ delivered. Apps that need CSS/JS must have them (or real inline). Incomplete work finishes as `partial`.
- **Gate stall caps** — Repeated finish-gate nudges must terminate as partial, not thrash forever.

### Chatre map

| Blueprint step | Code |
|----------------|------|
| Reason / briefing | `lib/understanding.js`, `lib/analyst.js`, `lib/agent.js` intake |
| Decide / tools | `lib/tool-defs.js`, model tool_calls |
| Guardrails | `lib/permissions.js`, `lib/allowlists.js`, `lib/autonomy.js` |
| Execute | `lib/agent.js` `executeRemoteTool`, shell/sandbox/browser/desktop |
| Observe | tool results → messages; `lib/smart-agent.js` shrink |
| Done proof | `lib/delivery-contract.js` `buildDoneProof` / `assessBuildCompleteness` |
| Team phases | `lib/team-pipeline.js`, `lib/blackboard.js` |

## 2. Instructions and protocols

Agents need programmatic guardrails. Broad conversational requests alone are unpredictable — partition instructions by scope.

```markdown
# Role
You are an expert full-stack autonomous software engineer executing file
modifications within a local developer workspace.

# Execution Constraints
- Think systematically before mutating tools.
- Do not hallucinate files. Inspect with list_directory / search before imports.
- Minimize file churn. Prefer patch_file over rewriting whole modules.
- Maintain compile-readiness after each mutating step.
```

### Modular file metadata (rules / globs)

Scale with conditional rules (Cursor-style `.mdc` / project `AGENTS.md`) injected by glob:

```markdown
---
description: Triggered when editing database schemas
globs: "src/db/**/*, prisma/schema.prisma"
---

# Database Layer Instructions
- Never run raw SQL migrations without confirmation.
- Prefer soft-delete via deletedAt where applicable.
```

In Chatre: `lib/project-rules.js`, per-project `AGENTS.md`, agent prompts in `lib/agents.js` / `lib/agent-prompt.js`.

## 3. Tooling ecosystem

Expose the host through granular APIs — not a naked terminal alone.

| Group | Examples | Responsibility |
|-------|----------|----------------|
| Navigation | `list_directory`, `view_tree`, `find_files` | Structure without dumping trees into RAM |
| Traversal | `view_file_outline`, `resolve_symbol` | Declarations without full bodies |
| Inspection | `read_file`, `search_code` | Targeted chunks |
| Mutation | `patch_file`, `apply_patch`, `write_file` | Isolated edits; validate matches |
| Execution | `execute_command`, `run_tests`, `preview_project` | Isolated / workspace modes |
| Browser / desktop | `navigate`, `computer`, `desktop_*` | Live web / OS companion |

### MCP

Standardize third-party tools via Model Context Protocol (JSON-RPC / stdio / WS) so servers can be hot-swapped without rewriting the planner. Chatre: `lib/mcp-client.js`, Settings → connectors.

```
┌──────────────────┐     JSON-RPC      ┌────────────────────┐
│  Agent Harness   ├──────────────────►│  MCP Client Proxy  │
│  (Reasoning)     │◄──────────────────┤         │          │
└──────────────────┘      Context      └─────────┬──────────┘
                                                 ▼
                                           Server registry
                                      (files, Docker, SaaS…)
```

## 4. State and context management

Separate live working memory from indexable repository search.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                      Context Management Architecture                       │
└────────────────────────────────────────────────────────────────────────────┘
 ├── [ Ephemeral Session RAM ]
 │    ├── Live chat thread (system prompts, recent turns)
 │    └── Virtual token buffer / compaction
 ├── [ Local State Tracker ]
 │    ├── File staging cache (agent diffs / filesTouched)
 │    └── Shell / browser / desktop session handles
 └── [ Durable Core Storage ]
      ├── Chunked embeddings + BM25 hybrid search
      └── Workspace FS graph / AST outline index
```

- **Dense embeddings** — Retrieve by meaning (“auth” → `jwt.ts`).
- **BM25** — Exact tokens (`ERR_CONN_TIMEOUT_302`).
- **AST / outline** — Before editing a class, inject precise dependency snippets.

Chatre pieces: `lib/context-rag.js`, `lib/context-cache.js`, `lib/file-outline.js`, `lib/import-graph.js`, workspace revision / SSE `file_event`.

## 5. Product invariants (do not regress)

1. **`hi` / thanks / short greetings** → light chat, no tools, no STRATEGY.md, no build todos — even if composer mode is Agent.
2. **Real builds** → plan/todos, force tools until files exist, completeness before `outcomeKind: delivered`.
3. **Browse / desktop** → correct task_type + runtime (Worker URL / companion); never invent results when offline.
4. **UI chrome** → one run bar; no status-pill flood; understanding strip only for agentic goals and auto-dismiss.

## Related entry points

- API loop: `lib/agent.js`
- Delivery honesty: `lib/delivery-contract.js`
- Fast path / scaffolds: `lib/build-delivery.js`
- UI agent stream: `chatre1/public/chat.js`, `composer.js`
