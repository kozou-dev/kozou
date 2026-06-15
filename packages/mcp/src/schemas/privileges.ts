import { z } from 'zod';

/** Effective privileges of the evaluated serving role on a relation
 *  (privilege-aware introspection, issue #99). Present in `describe_table` /
 *  `describe_view` output only when the MCP server was configured with a
 *  privilege role (`introspection.respectPrivileges` + a resolvable role);
 *  omitted in the default schema-wide mode. Advisory: it tells an agent what
 *  the role may *touch*; enforcement always stays in PostgreSQL (GRANTs + RLS). */
export const relationPrivilegesSchema = z.object({
  /** The role these privileges were evaluated for. */
  role: z.string(),
  /** May the role SELECT the relation (gated by schema USAGE). */
  select: z.boolean(),
  /** May the role INSERT into the relation. */
  insert: z.boolean(),
  /** May the role UPDATE the relation. */
  update: z.boolean(),
  /** May the role DELETE from the relation. */
  delete: z.boolean(),
});

export type RelationPrivilegesOutput = z.infer<typeof relationPrivilegesSchema>;
