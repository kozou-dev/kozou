import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parse as parseYAML } from 'yaml';
import type { RawIntrospection } from '@kozou/core';
import * as introspectModule from '@kozou/introspect';
import { inspectCommand } from '../src/commands/inspect.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), `kozou-inspect-${randomBytes(4).toString('hex')}-`));
}

function makeRawIntrospection(): RawIntrospection {
  return {
    serverVersion: '16.2',
    introspectedAt: '2026-01-01T00:00:00.000Z',
    schemas: ['public'],
    tables: [
      {
        schema: 'public',
        name: 'users',
        comment: 'Application users.',
        columns: [
          {
            name: 'id',
            dataType: 'uuid',
            udtName: 'uuid',
            nullable: false,
            defaultExpr: 'gen_random_uuid()',
            comment: null,
            position: 1,
          },
          {
            name: 'email',
            dataType: 'text',
            udtName: 'text',
            nullable: false,
            defaultExpr: null,
            comment: 'Login email.',
            position: 2,
          },
        ],
        primaryKey: ['id'],
        foreignKeys: [],
        checks: [],
        indexes: [],
        rowCountEstimate: null,
      },
    ],
    views: [],
    enums: [],
    functions: [],
  };
}

describe('inspectCommand', () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    vi.spyOn(introspectModule, 'introspect').mockResolvedValue(makeRawIntrospection());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.DATABASE_URL = originalEnv;
  });

  it('json format writes a JSON SchemaContext to stdout', async () => {
    let captured = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
    await inspectCommand({ format: 'json', output: '-', config: '/nonexistent/kozou.config.yaml' });
    stdoutSpy.mockRestore();

    expect(captured.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(captured);
    expect(parsed.meta.serverVersion).toBe('16.2');
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.tables[0].name).toBe('users');
    expect(parsed.tables[0].columns).toHaveLength(2);
  });

  it('yaml format writes valid YAML to a file', async () => {
    const dir = await makeTempDir();
    const outFile = join(dir, 'schema.yaml');
    await inspectCommand({
      format: 'yaml',
      output: outFile,
      config: '/nonexistent/kozou.config.yaml',
    });

    const content = await readFile(outFile, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    const parsed = parseYAML(content);
    expect(parsed.meta.serverVersion).toBe('16.2');
    expect(parsed.tables[0].name).toBe('users');
  });

  it('json format is the default when --format is omitted', async () => {
    const dir = await makeTempDir();
    const outFile = join(dir, 'schema.json');
    await inspectCommand({ output: outFile, config: '/nonexistent/kozou.config.yaml' });

    const content = await readFile(outFile, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.tables[0].name).toBe('users');
  });

  it('stdout (output: "-") is the default', async () => {
    let captured = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
    await inspectCommand({ format: 'json', config: '/nonexistent/kozou.config.yaml' });
    stdoutSpy.mockRestore();

    const parsed = JSON.parse(captured);
    expect(parsed.tables[0].name).toBe('users');
  });

  it('invalid format throws', async () => {
    await expect(
      inspectCommand({
        format: 'xml' as unknown as 'json',
        output: '-',
        config: '/nonexistent/kozou.config.yaml',
      }),
    ).rejects.toThrow(/invalid --format/);
  });

  it('calls introspect with the configured schemas', async () => {
    const spy = vi
      .spyOn(introspectModule, 'introspect')
      .mockResolvedValue(makeRawIntrospection());
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await inspectCommand({ format: 'json', output: '-', config: '/nonexistent/kozou.config.yaml' });
    stdoutSpy.mockRestore();

    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0];
    expect(call.connection).toBe('postgres://test:test@localhost:5432/test');
    expect(call.schemas).toEqual(['public']);
  });
});
