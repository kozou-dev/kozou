#!/usr/bin/env node
// `kozou` CLI entry point. Wires up the sub-commands via commander.

import { Command } from 'commander';
import { inspectCommand } from './commands/inspect.js';
import { codegenCommand } from './commands/codegen.js';
import { docsCommand } from './commands/docs.js';
import { mcpCommand } from './commands/mcp.js';
import { devCommand } from './commands/dev.js';
import { PACKAGE_VERSION } from './index.js';

type InspectFlags = {
  format?: 'json' | 'yaml';
  output?: string;
  config?: string;
};

type CodegenFlags = {
  output?: string;
  config?: string;
};

type DocsFlags = {
  output?: string;
  config?: string;
};

type McpFlags = {
  stdio?: boolean;
  http?: boolean;
  port?: number;
  host?: string;
  config?: string;
};

type DevFlags = {
  config?: string;
  adapter?: string;
  apiPort?: number;
};

const program = new Command()
  .name('kozou')
  .description('PostgreSQL compiler. One source, many faithful forms.')
  .version(PACKAGE_VERSION);

program
  .command('inspect')
  .description('Dump the Schema Context as JSON or YAML.')
  .option('--format <fmt>', 'output format: json | yaml', 'json')
  .option('--output <path>', 'output file (- for stdout)', '-')
  .option('--config <path>', 'path to kozou.config.yaml')
  .action(async (flags: InspectFlags) => {
    await inspectCommand({
      format: flags.format,
      output: flags.output,
      config: flags.config,
    });
  });

program
  .command('codegen')
  .description('Generate TypeScript row types from the database schema (experimental).')
  .option('--output <path>', 'output file (- for stdout)', '-')
  .option('--config <path>', 'path to kozou.config.yaml')
  .action(async (flags: CodegenFlags) => {
    await codegenCommand({
      output: flags.output,
      config: flags.config,
    });
  });

program
  .command('docs')
  .description('Generate a Markdown schema document from the database DDL + COMMENT.')
  .option('--output <path>', 'output file (- for stdout)', '-')
  .option('--config <path>', 'path to kozou.config.yaml')
  .action(async (flags: DocsFlags) => {
    await docsCommand({
      output: flags.output,
      config: flags.config,
    });
  });

program
  .command('mcp')
  .description('Run the MCP server (--stdio default, or --http).')
  .option('--stdio', 'use stdio transport (default)')
  .option('--http', 'use Streamable HTTP transport')
  .option('--port <n>', 'HTTP port (default 3334)', (raw) => parseInt(raw, 10))
  .option('--host <host>', 'HTTP bind host (default 127.0.0.1)')
  .option('--config <path>', 'path to kozou.config.yaml')
  .action(async (flags: McpFlags) => {
    await mcpCommand({
      stdio: flags.stdio,
      http: flags.http,
      port: flags.port,
      host: flags.host,
      config: flags.config,
    });
  });

program
  .command('dev')
  .description('Run the bundled Admin UI + MCP HTTP dev server.')
  .option('--config <path>', 'path to kozou.config.yaml')
  .option(
    '--adapter <kind>',
    'backend override (see kozou.config.yaml `adapter.type`); defaults to the in-house @kozou/api REST backend',
  )
  .option(
    '--api-port <n>',
    'port for the in-house @kozou/api server',
    (raw) => parseInt(raw, 10),
  )
  .action(async (flags: DevFlags) => {
    await devCommand({
      config: flags.config,
      adapter: flags.adapter,
      apiPort: flags.apiPort,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
