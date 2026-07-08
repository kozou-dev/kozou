# Kozou comparison benchmark

Measures how an AI agent's accuracy on business questions changes with the
database context it is given — generalizing the quickstart's single
"4.8x revenue" anecdote into a reproducible, falsifiable measurement.

This package is private and never published; it lives in the product repo so
every result is traceable to the exact Kozou version that produced the
context ("this MCP output scored this").

## Design

Same model, same fixture, same prompt template, same tasks. The **only**
independent variable is the database context block handed to the agent:

| Arm | Context | Models |
| --- | --- | --- |
| A0 | Raw DDL: system-catalog facts only (columns, types, constraints). No comments, no view definitions. | A naive integration pointed at the bare schema |
| A1 | A0 + verbatim `COMMENT` text, concatenated with no interpretation | A competitor that reads the same comments without Kozou's compilation (Phase 2) |
| A2 | Kozou-compiled context: the describe-tool outputs of a real, running `kozou mcp` server | The product's actual output |

- **A2 − A0** measures the total value of giving the agent meaning.
- **A2 − A1** isolates the value of Kozou's interpretation layer (structured
  `@ai`/`@policy`, views-as-concepts, recommended query paths) over merely
  having comments. Phase 1 runs A0 vs A2; A1 is implemented and lands in
  Phase 2.

The agent never sees data rows. It answers each question with a single SQL
statement; the harness executes that statement against the fixture (inside a
read-only transaction, as the fixture's read-only `analyst` role) and scores
the result against a pre-registered ground truth. Numeric tasks also record
the observed/expected ratio, so the *severity* of a miss (for example 4.8x)
is reported, not just pass/fail.

### Fixture and tasks

The fixture is [`examples/quickstart/schema.sql`](../examples/quickstart/schema.sql)
verbatim — a synthetic online-store domain whose business meaning lives in
`COMMENT` text and reporting views, not in column names. The task set
(12 tasks: source-of-truth aggregation, soft-delete filtering, status/enum
semantics, plus two no-trap controls) is pre-registered in
[`tasks/taskset.yaml`](tasks/taskset.yaml) with ground truth and the expected
trap direction per task. CI verifies every ground truth by executing each
task's canonical SQL against the live fixture (`test/groundtruth.test.ts`).

### Anti-rigging commitments

- **Pre-registration**: the task set, ground truths, and expected directions
  are frozen (committed) before any run; git history proves the ordering.
- **All tasks reported**: results always include every task, including tasks
  where the Kozou arm loses or ties, and the aggregate never hides the
  per-task breakdown.
- **No-trap controls**: two control tasks are expected to show *no* delta;
  they detect the Kozou context making answers worse (over-applying
  guidance).
- **Raw transcripts**: each run writes the full per-call records (SQL, notes,
  token usage, scores) plus the exact context blocks under `results/`, so
  the measurement can be audited and re-run independently.
- **Null results are results**: if the delta does not replicate, that is the
  headline finding, not a reason to adjust the tasks.

### Determinism

Current Claude models reject sampling parameters (temperature and friends),
so single-shot determinism is not available. Instead each (task, arm) cell is
run multiple times (default 5) and per-arm distributions are reported. The
model id, effort level, git commit, and fixture are recorded in each run's
`meta.json`.

## Running

Prerequisites:

- Docker (a `postgres:16` testcontainer is started per run)
- A built workspace: `pnpm install && pnpm -r build` (the A2 arm spawns the
  bundled CLI at `packages/kozou/dist/cli.js`)
- Anthropic API credentials (`ANTHROPIC_API_KEY`, or an `ant auth login`
  profile) — **the run calls a paid API**

```bash
pnpm --filter @kozou/benchmarks bench
```

Environment overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `KOZOU_BENCH_ARMS` | `A0,A2` | Comma-separated arm ids (add `A1` for the pass-through arm) |
| `KOZOU_BENCH_RUNS` | `5` | Runs per (task, arm) |
| `KOZOU_BENCH_MODEL` | `claude-sonnet-5` | Model under test |
| `KOZOU_BENCH_MCP_PORT` | `34551` | Port for the spawned `kozou mcp --http` |

Outputs land in `results/<runId>/`: `meta.json`, `contexts/<arm>.txt`,
`records.jsonl` (one line per task x arm x run), `summary.json`, and a
summary table on stdout.

Tests (no API calls, CI-safe):

```bash
pnpm --filter @kozou/benchmarks test
```

## Known asymmetries and review notes

These were raised in adversarial review and are kept **by design**; they are
documented here so readers can weigh them instead of discovering them:

- **`results/` is tracked on purpose.** Publishing raw transcripts in-repo is
  part of the falsifiability design, so results are not gitignored. Commit
  official runs only; delete scratch runs before staging.
- **A0 sees view names** (for example `vw_recognized_revenue`), because a
  naive agent connected to the database sees them too — hiding them would
  make A0 artificially weak. If A0 answers correctly by guessing from a view
  name, that is an honest result that weakens the measured delta.
- **A2 may include `rowCountEstimate`** (planner statistics) because A2 is
  the product's verbatim output; editing it would mean no longer measuring
  the product. Answers are scored by executing the agent's SQL, so a leaked
  estimate cannot directly produce a correct score.
- **`effort` is pinned to `high`**, which is the model's API default; it is
  recorded in each run's `meta.json`.
- **Scoring semantics**: numeric compare uses an absolute tolerance
  (default 0.005) plus an observed/expected ratio; string-set compare
  requires the exact row count (join fan-out duplicates are wrong answers);
  text compare is case-insensitive.

## Phases

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Design frozen; task set + ground truths pre-registered | done |
| 1 | MVP: A0 vs A2, one model, 12 tasks — "is there a delta at all?" | this package |
| 2 | Full: 3 arms (adds A1), more categories, second model tier | planned |
| 3 | Publication: results page + in-repo reproduction guide | planned |
