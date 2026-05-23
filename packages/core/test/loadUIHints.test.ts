import { describe, it, expect } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadUIHints, KozouUIHintsError } from '../src/loadUIHints.js';

async function makeTempYaml(content: string): Promise<string> {
  const dir = join(tmpdir(), `kozou-test-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'ui-hints.yaml');
  await writeFile(file, content, 'utf8');
  return file;
}

describe('loadUIHints', () => {
  it('empty file -> {} (all fields optional)', async () => {
    const file = await makeTempYaml('');
    const hints = await loadUIHints(file);
    expect(hints).toEqual({});
  });

  it('null doc (--- only) -> {}', async () => {
    const file = await makeTempYaml('---\n');
    const hints = await loadUIHints(file);
    expect(hints).toEqual({});
  });

  it('parses a small valid YAML', async () => {
    const file = await makeTempYaml(`
tables:
  foo:
    label: Foo
    columns:
      bar:
        widget: number
`);
    const hints = await loadUIHints(file);
    expect(hints.tables?.['foo']?.label).toBe('Foo');
    expect(hints.tables?.['foo']?.columns?.['bar']?.widget).toBe('number');
  });

  it('zod validation error (invalid widget) -> KozouUIHintsError', async () => {
    const file = await makeTempYaml(`
tables:
  foo:
    columns:
      bar:
        widget: not-a-widget
`);
    await expect(loadUIHints(file)).rejects.toBeInstanceOf(KozouUIHintsError);
    try {
      await loadUIHints(file);
    } catch (err) {
      const e = err as KozouUIHintsError;
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues[0]!.path).toMatch(/widget/);
    }
  });

  it('YAML syntax error -> KozouUIHintsError (with line number)', async () => {
    const file = await makeTempYaml('tables:\n  foo:\n    label: [unclosed\n');
    await expect(loadUIHints(file)).rejects.toBeInstanceOf(KozouUIHintsError);
    try {
      await loadUIHints(file);
    } catch (err) {
      const e = err as KozouUIHintsError;
      expect(e.issues.length).toBeGreaterThan(0);
      const hasLine = e.issues.some((i) => typeof i.line === 'number');
      expect(hasLine).toBe(true);
    }
  });

  it('missing file -> FS error', async () => {
    await expect(loadUIHints('/nonexistent/path/ui-hints.yaml')).rejects.toThrow();
  });

  it('empty label string (zod min(1) violation) -> KozouUIHintsError', async () => {
    const file = await makeTempYaml(`
tables:
  foo:
    label: ""
`);
    await expect(loadUIHints(file)).rejects.toBeInstanceOf(KozouUIHintsError);
  });
});
