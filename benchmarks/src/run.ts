// Benchmark runner (C-10 redesign).
//
// Pipeline:
//   1. Start one postgres:16 testcontainer; create one database per scale and
//      load that scale's generated fixture into `public` (what the shipped
//      demo does).
//   2. Preflight gates (once): the leak gate (arm A, non-agentic, core DDL,
//      strong-trap tasks) and the B competence gate (arm B on the gate tasks).
//      A run that fails a gate is still written, but the gate verdict is
//      recorded so the comparison is not read as valid.
//   3. For each scale, run the grid (task x arm x run) through the agentic
//      loop (A/B via catalog tools, C via a real `kozou mcp`), execute + score
//      + classify each answer. Optionally B-flat (companion).
//   4. Analyze this batch (task-level cluster bootstrap) and write
//      results/<runId>/ : meta.json, records.jsonl, summary.json, gates.json,
//      contexts/. Print a summary.
//
// Requirements: Docker, `pnpm -r build` (arm C spawns the bundled CLI), and
// Anthropic credentials (THIS CALLS A PAID API). Env overrides:
//   KOZOU_BENCH_SCALES   default "S,M,L"
//   KOZOU_BENCH_RUNS     default 10 (breadth screen; use 20 for confirm)
//   KOZOU_BENCH_ARMS     default "A,B,C"  (add "B-flat" to include the dump)
//   KOZOU_BENCH_MODEL    default claude-sonnet-5
//   KOZOU_BENCH_MCP_PORT default 34551
//   KOZOU_BENCH_BATCH    label for this batch (default "screen")
//   KOZOU_BENCH_CONCURRENCY default 4

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import Anthropic from '@anthropic-ai/sdk';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';

import { runAgentLoop, DEFAULT_MODEL, EFFORT, TOOL_CALL_CAP, type LoopResult } from './agent/loop.js';
import { askBFlat, generateBFlatContext } from './agent/bflat.js';
import { deriveCost } from './agent/cost.js';
import { createCatalogProvider } from './tools/provider.js';
import { createKozouMcpProvider } from './tools/mcpProxy.js';
import { loadFixture } from './fixture.js';
import { executeTaskSql, scoreRows, classifyOutcome, type Outcome } from './score.js';
import { loadTasks, loadGateTasks } from './tasks.js';
import { runLeakGate } from './gates/leakGate.js';
import { runBCompetenceGate } from './gates/bCompetenceGate.js';
import { analyzeBatch, DEFAULT_PARAMS, type CellRecord } from './stats/analyze.js';
import { generateSchema, SCALES as ALL_SCALES, type Scale } from './schema/generate.js';
import { armIds, type ArmId, type BenchTask } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(here, '../../packages/kozou/dist/cli.js');
const RESULTS_DIR = path.resolve(here, '../results');

const LEAK_THRESHOLD = Number(process.env.KOZOU_BENCH_LEAK_THRESHOLD ?? '0.40');
const BGATE_THRESHOLD = Number(process.env.KOZOU_BENCH_BGATE_THRESHOLD ?? '0.80');
const GATE_RUNS = Number(process.env.KOZOU_BENCH_GATE_RUNS ?? '5');

interface FullRecord extends CellRecord {
  outcome: Outcome;
  sql: string;
  notes: string;
  toolCalls: number;
  enumerateCalls: number;
  turns: number;
  errorRatio?: number;
  error?: string;
}

function parseScales(): Scale[] {
  const raw = process.env.KOZOU_BENCH_SCALES;
  if (!raw) return [...ALL_SCALES];
  return raw.split(',').map((s) => s.trim() as Scale).filter((s) => ALL_SCALES.includes(s));
}

function parseArms(): ArmId[] {
  const raw = process.env.KOZOU_BENCH_ARMS;
  if (!raw) return ['A', 'B', 'C'];
  const arms = raw.split(',').map((s) => s.trim()) as ArmId[];
  for (const a of arms) if (!armIds.includes(a)) throw new Error(`unknown arm ${a}`);
  return arms;
}

function dbUri(baseUri: string, dbName: string): string {
  const u = new URL(baseUri);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function startKozouMcp(databaseUrl: string, port: number): Promise<{ child: ChildProcess; url: string }> {
  if (!existsSync(CLI_PATH)) throw new Error(`bundled CLI not found at ${CLI_PATH} — run \`pnpm -r build\``);
  const child = spawn(process.execPath, [CLI_PATH, 'mcp', '--http', '--port', String(port)], {
    cwd: path.resolve(here, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`kozou mcp exited early (${child.exitCode})`);
    try {
      const probe = new McpClient({ name: 'kozou-bench-probe', version: '0.0.0' });
      await probe.connect(new StreamableHTTPClientTransport(new URL(url)));
      await probe.close();
      return { child, url };
    } catch {
      if (Date.now() > deadline) { child.kill('SIGTERM'); throw new Error('kozou mcp not ready in 30s'); }
      await sleep(500);
    }
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

async function withPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function gitCommit(): string {
  // execFileSync (no shell) with a fixed argument array — no injection surface.
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

interface Cell { task: BenchTask; arm: ArmId; run: number; scale: Scale; }

async function main(): Promise<void> {
  const scales = parseScales();
  const arms = parseArms();
  const runs = Number(process.env.KOZOU_BENCH_RUNS ?? '10');
  const model = process.env.KOZOU_BENCH_MODEL ?? DEFAULT_MODEL;
  const mcpPort = Number(process.env.KOZOU_BENCH_MCP_PORT ?? '34551');
  const batch = process.env.KOZOU_BENCH_BATCH ?? 'screen';
  const concurrency = Number(process.env.KOZOU_BENCH_CONCURRENCY ?? '4');
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`invalid RUNS ${runs}`);

  const tasks = loadTasks();
  const gateTasks = loadGateTasks();
  const anthropic = new Anthropic();

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(RESULTS_DIR, runId);
  mkdirSync(path.join(outDir, 'contexts'), { recursive: true });
  console.log(`run ${runId}: batch=${batch} model=${model} scales=${scales.join(',')} arms=${arms.join(',')} runs=${runs}`);

  console.log('starting postgres:16 testcontainer...');
  const container = await new PostgreSqlContainer('postgres:16').start();
  const baseUri = container.getConnectionUri();

  const admin = new pg.Client({ connectionString: baseUri });
  await admin.connect();

  const scaleDb: Record<string, { uri: string; pool: pg.Pool }> = {};
  const records: FullRecord[] = [];
  const gateResults: Record<string, unknown> = {};
  const mcpProcs: ChildProcess[] = [];

  try {
    // 1. Per-scale databases + fixtures.
    for (const scale of scales) {
      const dbName = `bench_${scale.toLowerCase()}`;
      await admin.query(`CREATE DATABASE ${dbName}`);
      const uri = dbUri(baseUri, dbName);
      const loader = new pg.Client({ connectionString: uri });
      await loader.connect();
      console.log(`loading fixture (scale ${scale}, ${generateSchema(scale).relationCount} relations)...`);
      await loadFixture(loader, 'public', scale);
      await loader.end();
      scaleDb[scale] = { uri, pool: new pg.Pool({ connectionString: uri, max: Math.max(6, concurrency * 2) }) };
    }

    // 2. Preflight gates (scale-independent core; run on the first available scale).
    const gateScale = scales.includes('S') ? 'S' : scales[0];
    const gatePool = scaleDb[gateScale].pool;
    {
      const c = await gatePool.connect();
      try {
        console.log('leak gate (arm A, non-agentic, strong-trap tasks)...');
        const leak = await runLeakGate(c, anthropic, model, 'public', tasks, LEAK_THRESHOLD, GATE_RUNS);
        gateResults.leakGate = leak;
        console.log(`  leak gate: A strong-trap accuracy ${(leak.accuracy * 100).toFixed(1)}% (threshold ${LEAK_THRESHOLD * 100}%) -> ${leak.pass ? 'PASS' : 'FAIL'}`);
        console.log('B competence gate (arm B on gate tasks)...');
        const bgate = await runBCompetenceGate(c, anthropic, model, 'public', gateTasks, BGATE_THRESHOLD, GATE_RUNS);
        gateResults.bCompetenceGate = bgate;
        console.log(`  B gate: accuracy ${(bgate.accuracy * 100).toFixed(1)}% (threshold ${BGATE_THRESHOLD * 100}%) -> ${bgate.pass ? 'PASS' : 'FAIL'}`);
      } finally {
        c.release();
      }
    }

    // 3. Main grid, per scale.
    for (const scale of scales) {
      const { uri, pool } = scaleDb[scale];
      let mcpUrl: string | null = null;
      if (arms.includes('C')) {
        const started = await startKozouMcp(uri, mcpPort);
        mcpProcs.push(started.child);
        mcpUrl = started.url;
      }
      // B-flat context (once per scale) if requested.
      let bflatContext: string | null = null;
      if (arms.includes('B-flat')) {
        const c = await pool.connect();
        try { bflatContext = await generateBFlatContext(c, 'public'); } finally { c.release(); }
        writeFileSync(path.join(outDir, 'contexts', `bflat-${scale}.txt`), bflatContext);
      }

      const cells: Cell[] = [];
      for (const task of tasks) for (const arm of arms) for (let run = 1; run <= runs; run += 1) cells.push({ task, arm, run, scale });
      console.log(`scale ${scale}: ${cells.length} cells (concurrency ${concurrency})...`);
      let done = 0;

      const scaleRecords = await withPool(cells, concurrency, async (cell): Promise<FullRecord> => {
        const rec = await runCell(cell, pool, mcpUrl, bflatContext, anthropic, model);
        done += 1;
        if (done % 25 === 0) console.log(`  ${done}/${cells.length}`);
        return rec;
      });
      records.push(...scaleRecords);

      for (const p of mcpProcs) await stopProcess(p);
      mcpProcs.length = 0;
    }

    // 4. Analyze + write.
    const cellRecords: CellRecord[] = records.map((r) => ({
      taskId: r.taskId, scale: r.scale, arm: r.arm, run: r.run,
      correct: r.correct, billedInput: r.billedInput, uncachedInput: r.uncachedInput, capHit: r.capHit,
    }));
    const gatedRecords = cellRecords.filter((r) => r.arm === 'A' || r.arm === 'B' || r.arm === 'C');
    const report = analyzeBatch(gatedRecords, DEFAULT_PARAMS);

    const meta = {
      runId, batch, model, effort: EFFORT, scales, arms, runsPerCell: runs,
      toolCallCap: TOOL_CALL_CAP, taskCount: tasks.length, gateTaskCount: gateTasks.length,
      schemaSeed: generateSchema(scales[0]).seed, gitCommit: gitCommit(),
      leakThreshold: LEAK_THRESHOLD, bGateThreshold: BGATE_THRESHOLD,
      preRegParams: DEFAULT_PARAMS,
      note: 'Sampling params unavailable on this model; variance is via runs. Analysis unit is the task (cluster bootstrap). See README.md.',
    };
    writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
    writeFileSync(path.join(outDir, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ meta, report }, null, 2));
    writeFileSync(path.join(outDir, 'gates.json'), JSON.stringify(gateResults, null, 2));

    printSummary(report, gateResults);
    console.log(`\nresults written to ${outDir}`);
  } finally {
    for (const p of mcpProcs) await stopProcess(p);
    for (const s of Object.keys(scaleDb)) await scaleDb[s].pool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    await container.stop();
  }
}

async function runCell(
  cell: Cell,
  pool: pg.Pool,
  mcpUrl: string | null,
  bflatContext: string | null,
  anthropic: Anthropic,
  model: string,
): Promise<FullRecord> {
  const { task, arm, run, scale } = cell;
  const base = {
    taskId: task.id, scale, arm, run,
    correct: false, billedInput: 0, uncachedInput: 0, capHit: false,
    outcome: 'no-answer' as Outcome, sql: '', notes: '', toolCalls: 0, enumerateCalls: 0, turns: 0,
  };

  // B-flat: single-shot dump.
  if (arm === 'B-flat') {
    if (bflatContext === null) return { ...base, error: 'no b-flat context' };
    const res = await askBFlat(anthropic, model, task, bflatContext);
    const scoreClient = await pool.connect();
    try {
      return finalize(base, res.ok, res.sql, res.notes, res.usage, false, task, scoreClient, res.error);
    } finally { scoreClient.release(); }
  }

  // Gated arms: agentic loop.
  let loop: LoopResult;
  let provider;
  let leaseClient: pg.PoolClient | null = null;
  if (arm === 'C') {
    if (!mcpUrl) return { ...base, error: 'no mcp url' };
    provider = await createKozouMcpProvider(mcpUrl);
  } else {
    leaseClient = await pool.connect();
    provider = createCatalogProvider(leaseClient, 'public', arm === 'B');
  }
  try {
    loop = await runAgentLoop({ client: anthropic, model, task, provider });
  } finally {
    await provider.close();
  }

  const scoreClient = leaseClient ?? (await pool.connect());
  try {
    return {
      ...finalize(base, loop.ok, loop.sql, loop.notes, loop.usage, loop.capHit, task, scoreClient, loop.error),
      toolCalls: loop.toolCalls, enumerateCalls: loop.enumerateCalls, turns: loop.turns,
    };
  } finally {
    if (leaseClient) leaseClient.release();
    else scoreClient.release();
  }
}

async function finalize(
  base: FullRecord,
  agentOk: boolean,
  sql: string,
  notes: string,
  usage: Parameters<typeof deriveCost>[0],
  capHit: boolean,
  task: BenchTask,
  client: pg.PoolClient,
  agentError?: string,
): Promise<FullRecord> {
  const cost = deriveCost(usage);
  let execOk = false;
  let correct = false;
  let errorRatio: number | undefined;
  let error = agentError;
  if (agentOk && sql.trim() !== '') {
    const exec = await executeTaskSql(client, sql);
    execOk = exec.ok;
    if (exec.ok) {
      const score = scoreRows(task.scoring, exec.rows);
      correct = score.correct;
      errorRatio = score.errorRatio;
    } else {
      error = exec.error;
    }
  }
  return {
    ...base,
    correct,
    billedInput: cost.billedInput,
    uncachedInput: cost.uncachedInput,
    capHit,
    outcome: classifyOutcome(agentOk, execOk, correct),
    sql, notes, errorRatio, error,
  };
}

function printSummary(report: ReturnType<typeof analyzeBatch>, gates: Record<string, unknown>): void {
  console.log('\n=== C-10 benchmark summary ===');
  console.log('gates:', JSON.stringify(gates && Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, (v as { pass?: boolean }).pass]))));
  console.log('per-arm accuracy by scale:');
  for (const arm of ['A', 'B', 'C']) {
    const acc = report.armAccuracy[arm];
    console.log(`  ${arm}: ${Object.entries(acc).map(([s, v]) => `${s}=${(v * 100).toFixed(0)}%`).join(' ')}`);
  }
  console.log('per-arm billed input (mean, non-cap) by scale:');
  for (const arm of ['A', 'B', 'C']) {
    const c = report.armBilled[arm];
    console.log(`  ${arm}: ${Object.entries(c).map(([s, v]) => `${s}=${Math.round(v)}`).join(' ')}`);
  }
  console.log('accuracy delta C-B by scale (95% CI):');
  for (const [s, ci] of Object.entries(report.accuracyDelta)) {
    console.log(`  ${s}: ${ci.point.toFixed(3)} [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
  }
  console.log(`cost slope ratio B/C (97.5% CI): ${report.slopeRatioBoverC.point.toFixed(2)} [${report.slopeRatioBoverC.lo.toFixed(2)}, ${report.slopeRatioBoverC.hi.toFixed(2)}]`);
  console.log(`DECISION: ${report.decision.scenario}`, JSON.stringify(report.decision));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
