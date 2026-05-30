import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createKozouScaffold, KozouScaffoldError } from '../src/scaffold.js';

async function makeTempBase(): Promise<string> {
  return mkdtemp(join(tmpdir(), `kozou-scaffold-${randomBytes(4).toString('hex')}-`));
}

async function makeTemplateDir(): Promise<string> {
  const base = await makeTempBase();
  const templates = join(base, 'templates');
  await mkdir(join(templates, 'migrations'), { recursive: true });
  await writeFile(join(templates, 'kozou.config.yaml'), 'database:\n  url: ${DATABASE_URL}\n', 'utf8');
  await writeFile(join(templates, 'ui-hints.yaml'), 'tables: {}\n', 'utf8');
  await writeFile(join(templates, 'env.example'), 'DATABASE_URL=postgres://x\n', 'utf8');
  await writeFile(join(templates, 'docker-compose.yml'), 'services: {}\n', 'utf8');
  await writeFile(
    join(templates, 'migrations/0001_init.sql'),
    '-- Add your schema here.\n',
    'utf8',
  );
  return templates;
}

describe('createKozouScaffold', () => {
  it('copies the template tree into a fresh target directory', async () => {
    const templatesDir = await makeTemplateDir();
    const base = await makeTempBase();
    const target = join(base, 'my-app');

    await createKozouScaffold({ target, templatesDir });

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, 'kozou.config.yaml'))).toBe(true);
    expect(existsSync(join(target, 'ui-hints.yaml'))).toBe(true);
    expect(existsSync(join(target, 'docker-compose.yml'))).toBe(true);
    expect(existsSync(join(target, 'migrations/0001_init.sql'))).toBe(true);

    const config = await readFile(join(target, 'kozou.config.yaml'), 'utf8');
    expect(config).toContain('${DATABASE_URL}');
  });

  it('renames env.example to .env.example in the target', async () => {
    const templatesDir = await makeTemplateDir();
    const base = await makeTempBase();
    const target = join(base, 'my-app');

    await createKozouScaffold({ target, templatesDir });

    expect(existsSync(join(target, '.env.example'))).toBe(true);
    expect(existsSync(join(target, 'env.example'))).toBe(false);
    const env = await readFile(join(target, '.env.example'), 'utf8');
    expect(env).toContain('DATABASE_URL=postgres://x');
  });

  it('throws if the target directory already exists', async () => {
    const templatesDir = await makeTemplateDir();
    const base = await makeTempBase();
    const target = join(base, 'existing');
    await mkdir(target);

    await expect(
      createKozouScaffold({ target, templatesDir }),
    ).rejects.toBeInstanceOf(KozouScaffoldError);
  });

  it('creates missing parent directories of the target', async () => {
    const templatesDir = await makeTemplateDir();
    const base = await makeTempBase();
    // Two parent levels that do not exist yet: the target mkdir is
    // non-recursive (for the atomic EEXIST guard), so the parent chain
    // must be created first.
    const target = join(base, 'nested', 'deep', 'my-app');

    await createKozouScaffold({ target, templatesDir });

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, 'kozou.config.yaml'))).toBe(true);
  });

  it('throws when target is empty', async () => {
    await expect(createKozouScaffold({ target: '' })).rejects.toBeInstanceOf(
      KozouScaffoldError,
    );
    await expect(createKozouScaffold({ target: '   ' })).rejects.toBeInstanceOf(
      KozouScaffoldError,
    );
  });

  it('preserves subdirectory structure (migrations/)', async () => {
    const templatesDir = await makeTemplateDir();
    const base = await makeTempBase();
    const target = join(base, 'my-app');

    await createKozouScaffold({ target, templatesDir });

    const migrationsStat = await stat(join(target, 'migrations'));
    expect(migrationsStat.isDirectory()).toBe(true);
    const sql = await readFile(join(target, 'migrations/0001_init.sql'), 'utf8');
    expect(sql).toContain('Add your schema here');
  });
});
