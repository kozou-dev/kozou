# Kozou comparison benchmark

Measures how an AI agent's **accuracy** and **cost** on business questions
change with the database context it is given — on a legacy-named synthetic
schema at three scales. This is a redesign of the earlier Phase-1 MVP; it fixes
that version's measured weaknesses (a naive arm that recovered meaning from
readable names/views, a ceiling effect, and flat-dump arms that never measured
selective retrieval).

This package is **private and never published**; it lives in the product repo
so every result is traceable to the exact Kozou version that produced the
context.

## Design

Same model, same fixture, same prompt, same tasks. The **only** independent
variable is the database context handed to the agent and how it gets it. Every
gated arm runs the **same agentic tool-use loop** — the agent selectively calls
tools, sees only what it fetches, and finishes by calling `submit_answer` with
one SQL statement. The harness executes that SQL (read-only transaction, as the
fixture's read-only `analyst` role, multi-statement rejected) and scores it
against a pre-registered, CI-verified ground truth.

| Arm | Context | Tools |
| --- | --- | --- |
| **A** | Comment-less: raw DDL only (columns, types, constraints, view definitions). Models a naive integration on a bare schema. | `list_tables`, `describe_table`, `list_views`, `describe_view` |
| **B** | Strongest realistic generic MCP: raw DDL **plus verbatim COMMENT text** (tables/columns/views/constraints) and a full-text search over all comments. No interpretation. | above **+ `search_comments`** |
| **C** | Kozou: drives a real `kozou mcp` server via a real MCP client; the agent calls the product's actual tools. | the product's tools |
| **B-flat** | Companion only (**not gated**): B-style describe of every relation, concatenated, answered single-shot. Shows the arithmetic-trivial token reduction of a flat dump. | none (single-shot) |

- **B − A** measures the value of writing meaning into the database as comments.
- **C − B** isolates Kozou's *compilation* of that meaning (structured
  `@ai`/`@policy`, views-as-concepts, FK-derived join purpose, recommended
  query paths) over merely having the raw comments. B is deliberately given
  view/constraint reach and comment search so the delta is not an artifact of
  which objects a tool can see. **C − B is the headline.**

### Scale is the main manipulation

The **core** business domain (the ~4 tables + 2 views that every task queries)
is fixed and identical at all scales; scale changes only the number of
meaningless **noise** tables around it:

| Scale | Relations | Role |
| --- | --- | --- |
| S | ≤ 20 | small haystack |
| M | ≤ 80 | medium |
| L | ≥ 200 | large — where selective navigation should pay off |

Because the core (and every `canonical_sql`) is identical across scales,
accuracy is comparable across scales and the **cost-vs-scale slope** is the
primary cost signal: Kozou's concept navigation should stay roughly flat while
a generic MCP's describe/search cost grows with the schema.

### Legacy naming (no meaning in names)

All relation/column names are opaque, deterministically mangled tokens (see
`src/schema/mangle.ts`); **all** business meaning lives in `COMMENT` text.
Views are real and visible to every arm but are pure joins with no business
filtering, so no single view SELECT answers a task. `src/schema/emit.ts` prints
the schema and the name legend.

### Cost metrics

Per (task, arm, run) the loop records raw token fields per turn
(`input`, `cache_creation`, `cache_read`, `output`), tool-call count, turn
count, wall time, and whether the tool-call cap was hit. Two headline
derivations: **billed** input tokens (with prompt caching, the real cost) and
**uncached** input tokens (intrinsic context volume, a mechanism diagnostic).
Cap-hit runs are reported as a rate and excluded from the primary cost model
(with a sensitivity analysis that includes them), so "cheap because it never
finished" cannot masquerade as efficiency.

### Anti-rigging

- **Pre-registration**: the task set, ground truths, trap directions,
  difficulty tiers, scales, name mangling, and the statistical decision rules
  are frozen (committed) before any run; git history proves the schema and its
  comments were committed **before** the task set (`commit S` then `commit T`),
  so comments were not tuned to the tasks. This proves *time order*, not
  constructive independence — the same author authored both.
- **Leak gate**: before the comparison, arm A is run **non-agentically** (full
  core DDL presented at once, zero navigation load) on the strong-trap tasks
  only; if A scores above the pre-registered threshold, names are leaking
  meaning and the fixture is re-mangled (bounded retries, then redesign).
- **B competence gate**: arm B must solve a set of "answer-is-in-a-comment"
  tasks at a high rate, proving its search + comment path works (the
  counterpart to the leak gate).
- **Example guard**: no `@example` / recommended query path in any comment may
  reproduce a task's `canonical_sql`, so the Kozou arm cannot be handed the
  answer verbatim.
- **All tasks reported**; **null results are results**.

### Determinism

Current Claude models reject sampling parameters, so single-shot determinism is
unavailable. Each (task, arm, scale) cell is run multiple times and per-cell
distributions are reported; the analysis unit is the **task** (runs estimate
within-task variance only). The model id, effort, git commit, MCP version,
prompt, tool definitions, cap, caching setting, and mangling seed are pinned
and recorded per run.

## Running

Prerequisites: Docker (a `postgres:16` testcontainer per run), a built
workspace (`pnpm install && pnpm -r build` — arm C spawns the bundled CLI), and
Anthropic API credentials (**the `bench` script calls a paid API**).

```bash
pnpm --filter @kozou/benchmarks bench          # the comparison (paid)
pnpm --filter @kozou/benchmarks test           # CI-safe: no API calls
pnpm --filter @kozou/benchmarks emit-schema L --summary   # inspect the schema
```

Tests load a generated fixture and verify ground truths + tool behaviour; they
never call the paid API.
