// Which commands row-level security refuses outright, derived from the two
// catalog columns that can be read without touching a policy expression.
//
// The gap this closes: `hasPolicies` is per table, RLS is enforced per command.
// A table can be enabled, carry a policy, hold the GRANT and still refuse every
// INSERT — because the only policy written was `FOR SELECT`. Everything an agent
// is told today is accurate, and none of it predicts that refusal.
//
// Only the negative is soundly derivable, and only these two columns are
// needed for it. Three ways a positive ("this command has a policy, so it
// works") reads wrong, all of them measured on PostgreSQL 16 against tables
// that differ only in how the single policy is written:
//
//   - `FOR ALL` is stored as `polcmd = '*'`, so counting per command reports
//     zero INSERT policies for a table that inserts fine. This is the dangerous
//     direction: it predicts a refusal that does not happen;
//   - a restrictive policy (`polpermissive = false`) grants nothing — a command
//     whose only policy is restrictive is still default-deny;
//   - `polroles` scopes a policy to particular roles, so a policy can exist for
//     the command and not apply to the connecting one.
//
// The last of those is also why roles are not consulted here: the answer is
// deliberately the same for every role, which is what makes it safe to compile
// once and hand to anyone. A command with no permissive policy is refused for
// every role RLS applies to — owners included when the table is FORCEd, and a
// role with BYPASSRLS still bypasses the whole mechanism.
//
// So this is sound but not complete, and the incompleteness falls the safe way:
// a command reported denied IS denied, while a command not reported may still be
// refused — by a policy that names other roles, or by a USING expression that
// matches no row. Nothing here can say a write will succeed, and nothing here
// tries to.

import type { RlsCommand } from '@kozou/core';

/** `pg_policy.polcmd` codes. `'*'` is `FOR ALL` and covers every command. */
const COMMAND_BY_POLCMD: Record<string, RlsCommand> = {
  r: 'select',
  a: 'insert',
  w: 'update',
  d: 'delete',
};

/** Fixed order, so the field reads the same across runs and diffs. */
const ALL_COMMANDS: readonly RlsCommand[] = ['select', 'insert', 'update', 'delete'];

/**
 * Commands with no permissive policy that could apply.
 *
 * @param enabled `pg_class.relrowsecurity` — RLS refuses nothing while it is off.
 * @param permissivePolcmds the distinct `polcmd` codes of the table's
 *        PERMISSIVE policies (restrictive ones are filtered out by the query,
 *        because they never grant).
 */
export function deniedCommands(enabled: boolean, permissivePolcmds: readonly string[]): RlsCommand[] {
  if (!enabled) return [];
  if (permissivePolcmds.includes('*')) return [];
  const covered = new Set(
    permissivePolcmds.map((code) => COMMAND_BY_POLCMD[code]).filter((c): c is RlsCommand => c !== undefined),
  );
  return ALL_COMMANDS.filter((command) => !covered.has(command));
}
