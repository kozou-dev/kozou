// Benchmark runner (Phase 1 MVP).
//
// Pipeline:
//   1. Start a fresh Postgres 16 testcontainer and load the quickstart
//      fixture into `public` — exactly what the shipped demo does.
//   2. Generate each arm's context once. A2 spawns the BUILT bundled CLI
//      (`node ../packages/kozou/dist/cli.js mcp --http`) and drives it with a
//      real MCP client, so the measured context is the product's real output.
//   3. Ask the model (tasks x arms x runs, small concurrency pool), then
//      execute every returned SQL statement sequentially and score it.
//   4. Write records.jsonl / summary.json / contexts / meta.json under
//      results/<runId>/ and print a summary table.
//
// Requirements: Docker, `pnpm -r build` (for the bundled CLI), and Anthropic
// API credentials (ANTHROPIC_API_KEY or an `ant auth login` profile).
//
// Environment overrides:
//   KOZOU_BENCH_ARMS   comma-separated arm ids (default "A0,A2")
//   KOZOU_BENCH_RUNS   runs per task x arm      (default 5)
//   KOZOU_BENCH_MODEL  model id                 (default claude-sonnet-5)
//   KOZOU_BENCH_MCP_PORT  port for the spawned kozou mcp (default 34551)

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';

import {
  askAgent,
  buildPrompt,
  createAnthropicClient,
  DEFAULT_MODEL,
  EFFORT,
  type AgentAnswer,
} from './agent.js';
import { generateRawDdlContext } from './arms/a0RawDdl.js';
import { generateRawCommentContext } from './arms/a1RawComment.js';
import { generateKozouMcpContext } from './arms/a2KozouMcp.js';
import { loadFixtureSql } from './fixture.js';
import { executeTaskSql, scoreRows, type Score } from './score.js';
import { loadTasks } from './tasks.js';
import { armIds, type ArmId, type BenchTask } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(here, '../../packages/kozou/dist/cli.js');
const RESULTS_DIR = path.resolve(here, '../results');
const SCHEMA = 'public';
const CONCURRENCY = 4;

interface RunRecord {
  taskId: string;
  category: string;
  arm: ArmId;
  run: number;
  model: string;
  agent: AgentAnswer;
  execution: { ok: boolean; error?: string };
  score: Score | null;
  correct: boolean;
}

function parseArms(raw: string | undefined): ArmId[] {
  if (!raw) return ['A0', 'A2'];
  const arms = raw.split(',').map((s) => s.trim()) as ArmId[];
  for (const arm of arms) {
    if (!armIds.includes(arm)) {
      throw new Error(`unknown arm "${arm}" (expected ${armIds.join(', ')})`);
    }
  }
  return arms;
}

async function startKozouMcp(
  databaseUrl: string,
  port: number,
): Promise<{ child: ChildProcess; url: string }> {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `bundled CLI not found at ${CLI_PATH} — run \`pnpm -r build\` first`,
    );
  }
  const child = spawn(
    process.execPath,
    [CLI_PATH, 'mcp', '--http', '--port', String(port)],
    {
      cwd: path.resolve(here, '..'),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  const url = `http://127.0.0.1:${port}/mcp`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`kozou mcp exited early with code ${child.exitCode}`);
    }
    try {
      const probe = new McpClient({ name: 'kozou-bench-probe', version: '0.0.0' });
      await probe.connect(new StreamableHTTPClientTransport(new URL(url)));
      await probe.close();
      return { child, url };
    } catch {
      if (Date.now() > deadline) {
        child.kill('SIGTERM');
        throw new Error('kozou mcp did not become ready within 30s');
      }
      await sleep(500);
    }
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function withPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function gitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: here, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

interface ArmSummary {
  arm: ArmId;
  total: number;
  correct: number;
  accuracy: number;
  agentFailures: number;
  executionFailures: number;
  byCategory: Record<string, { total: number; correct: number }>;
  byTask: Record<
    string,
    { total: number; correct: number; failures: number; errorRatios: number[] }
  >;
}

function summarize(records: RunRecord[], arms: ArmId[]): ArmSummary[] {
  return arms.map((arm) => {
    const own = records.filter((r) => r.arm === arm);
    const summary: ArmSummary = {
      arm,
      total: own.length,
      correct: own.filter((r) => r.correct).length,
      accuracy: 0,
      agentFailures: own.filter((r) => !r.agent.ok).length,
      executionFailures: own.filter((r) => r.agent.ok && !r.execution.ok).length,
      byCategory: {},
      byTask: {},
    };
    summary.accuracy = summary.total === 0 ? 0 : summary.correct / summary.total;
    for (const record of own) {
      const cat = (summary.byCategory[record.category] ??= {
        total: 0,
        correct: 0,
      });
      cat.total += 1;
      if (record.correct) cat.correct += 1;
      const task = (summary.byTask[record.taskId] ??= {
        total: 0,
        correct: 0,
        failures: 0,
        errorRatios: [],
      });
      task.total += 1;
      if (record.correct) task.correct += 1;
      if (!record.agent.ok || !record.execution.ok) task.failures += 1;
      if (record.score?.errorRatio !== undefined) {
        task.errorRatios.push(record.score.errorRatio);
      }
    }
    return summary;
  });
}

function printSummary(tasks: BenchTask[], summaries: ArmSummary[]): void {
  console.log('\n=== Benchmark summary ===');
  for (const summary of summaries) {
    console.log(
      `arm ${summary.arm}: ${summary.correct}/${summary.total} correct ` +
        `(${(summary.accuracy * 100).toFixed(1)}%), ` +
        `${summary.agentFailures} agent failure(s), ` +
        `${summary.executionFailures} SQL execution failure(s)`,
    );
    for (const [category, stats] of Object.entries(summary.byCategory)) {
      console.log(`  ${category}: ${stats.correct}/${stats.total}`);
    }
  }
  console.log(
    '\nPer task (correct/runs, mean observed/expected ratio over scored runs, failures):',
  );
  for (const task of tasks) {
    const cells = summaries.map((summary) => {
      const stats = summary.byTask[task.id];
      if (!stats) return `${summary.arm} -`;
      const ratios = stats.errorRatios;
      // The mean ratio only covers runs whose SQL executed; always print the
      // failure count next to it so a failure-heavy cell cannot look benign.
      const meanRatio =
        ratios.length > 0
          ? (ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2)
          : 'n/a';
      return `${summary.arm} ${stats.correct}/${stats.total} (ratio ${meanRatio}, fail ${stats.failures})`;
    });
    console.log(`  ${task.id} [${task.category}]  ${cells.join('  |  ')}`);
  }
}

async function main(): Promise<void> {
  const arms = parseArms(process.env.KOZOU_BENCH_ARMS);
  const runs = Number(process.env.KOZOU_BENCH_RUNS ?? '5');
  const model = process.env.KOZOU_BENCH_MODEL ?? DEFAULT_MODEL;
  const mcpPort = Number(process.env.KOZOU_BENCH_MCP_PORT ?? '34551');
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`invalid KOZOU_BENCH_RUNS: ${process.env.KOZOU_BENCH_RUNS}`);
  }

  const tasks = loadTasks();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(RESULTS_DIR, runId);
  mkdirSync(path.join(outDir, 'contexts'), { recursive: true });

  console.log(`run ${runId}: model=${model} arms=${arms.join(',')} runs=${runs}`);
  console.log('starting postgres:16 testcontainer...');
  const container = await new PostgreSqlContainer('postgres:16').start();
  const databaseUrl = container.getConnectionUri();
  const db = new pg.Client({ connectionString: databaseUrl });

  let mcpProcess: ChildProcess | null = null;
  try {
    await db.connect();
    console.log('loading quickstart fixture...');
    await db.query(loadFixtureSql(SCHEMA));

    const contexts = new Map<ArmId, string>();
    for (const arm of arms) {
      console.log(`generating context for arm ${arm}...`);
      if (arm === 'A0') {
        contexts.set(arm, await generateRawDdlContext(db, SCHEMA));
      } else if (arm === 'A1') {
        contexts.set(arm, await generateRawCommentContext(db, SCHEMA));
      } else {
        const started = await startKozouMcp(databaseUrl, mcpPort);
        mcpProcess = started.child;
        contexts.set(arm, await generateKozouMcpContext(started.url, SCHEMA));
        await stopProcess(mcpProcess);
        mcpProcess = null;
      }
      writeFileSync(
        path.join(outDir, 'contexts', `${arm}.txt`),
        contexts.get(arm) ?? '',
      );
    }

    const anthropic = createAnthropicClient();
    const calls: Array<{ task: BenchTask; arm: ArmId; run: number }> = [];
    for (const task of tasks) {
      for (const arm of arms) {
        for (let run = 1; run <= runs; run += 1) {
          calls.push({ task, arm, run });
        }
      }
    }
    console.log(`asking the model (${calls.length} calls, concurrency ${CONCURRENCY})...`);
    let done = 0;
    const answers = await withPool(calls, CONCURRENCY, async (call) => {
      const context = contexts.get(call.arm);
      if (context === undefined) throw new Error(`missing context for ${call.arm}`);
      const answer = await askAgent(
        anthropic,
        model,
        buildPrompt(call.task, context),
      );
      done += 1;
      if (done % 10 === 0) console.log(`  ${done}/${calls.length} calls done`);
      return answer;
    });

    console.log('executing and scoring SQL...');
    const records: RunRecord[] = [];
    for (let i = 0; i < calls.length; i += 1) {
      const { task, arm, run } = calls[i];
      const agent = answers[i];
      if (!agent.ok) {
        records.push({
          taskId: task.id,
          category: task.category,
          arm,
          run,
          model,
          agent,
          execution: { ok: false, error: 'agent did not produce SQL' },
          score: null,
          correct: false,
        });
        continue;
      }
      const execution = await executeTaskSql(db, agent.sql);
      const score = execution.ok ? scoreRows(task.scoring, execution.rows) : null;
      records.push({
        taskId: task.id,
        category: task.category,
        arm,
        run,
        model,
        agent,
        execution: { ok: execution.ok, error: execution.error },
        score,
        correct: score?.correct ?? false,
      });
    }

    const summaries = summarize(records, arms);
    const meta = {
      runId,
      model,
      effort: EFFORT,
      arms,
      runsPerTaskArm: runs,
      taskCount: tasks.length,
      gitCommit: gitCommit(),
      fixture: 'examples/quickstart/schema.sql',
      startedAt: runId,
      note:
        'Sampling parameters are unavailable on this model; variance is ' +
        'reported across runs instead. See benchmarks/README.md.',
    };
    writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
    writeFileSync(
      path.join(outDir, 'records.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify({ meta, summaries }, null, 2),
    );

    printSummary(tasks, summaries);
    console.log(`\nresults written to ${outDir}`);
  } finally {
    if (mcpProcess) await stopProcess(mcpProcess);
    await db.end().catch(() => undefined);
    await container.stop();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
