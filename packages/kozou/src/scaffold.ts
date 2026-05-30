// `create-kozou` scaffolding logic.
//
// Copies the contents of packages/kozou/src/templates/ into the target
// directory the user picks. Renames env.example to .env.example along
// the way so the scaffolded project ships a real dotfile (the template
// stays a normal file because npm's tarball handling for dotfiles
// inside published packages can be surprising).

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TEMPLATE_DIR = fileURLToPath(new URL('./templates', import.meta.url));

export type CreateScaffoldOptions = {
  /** Target directory. Must not already exist. */
  target: string;
  /** Override the templates directory (used by unit tests). */
  templatesDir?: string;
};

export class KozouScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KozouScaffoldError';
  }
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(src, entry.name);
    let targetName = entry.name;
    // env.example -> .env.example so the scaffolded project has a real
    // dotfile but the template itself stays out of dotfile-tooling
    // edge cases when published to npm.
    if (entry.isFile() && entry.name === 'env.example') {
      targetName = '.env.example';
    }
    const destPath = join(dest, targetName);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyRecursive(sourcePath, destPath);
    } else if (entry.isFile()) {
      const content = await readFile(sourcePath, 'utf8');
      await writeFile(destPath, content, 'utf8');
    }
    // Symlinks and other entry kinds are skipped intentionally.
  }
}

export async function createKozouScaffold(opts: CreateScaffoldOptions): Promise<void> {
  const target = (opts.target ?? '').trim();
  if (target === '') {
    throw new KozouScaffoldError('create-kozou: target directory is required');
  }
  const templatesDir = opts.templatesDir ?? DEFAULT_TEMPLATE_DIR;
  // Create any missing parent directories, then create the target itself
  // with a NON-recursive mkdir so an already-existing target fails
  // atomically with EEXIST. A recursive mkdir silently succeeds on an
  // existing directory, so the previous existsSync()-then-mkdir guard had
  // a TOCTOU window (the target could be created between the check and the
  // mkdir); letting mkdir own the "must not exist" check closes it.
  await mkdir(dirname(target), { recursive: true });
  try {
    await mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new KozouScaffoldError(`create-kozou: "${target}" already exists`);
    }
    throw err;
  }
  await copyRecursive(templatesDir, target);
}
