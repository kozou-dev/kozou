// Dashboard: list the schema's tables, each linking to its list view.
// The schema comes from the same introspection pipeline the reference UI
// uses; this page adds no logic of its own beyond rendering.

import { getSchema } from '@/lib/server/schema';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const schema = await getSchema();

  return (
    <>
      <h1>Tables</h1>
      <p className="subtitle">
        @kozou/example-react — read-only spike over @kozou/ui-core
      </p>

      {schema.tables.length === 0 ? (
        <p className="empty">No tables in the introspected schema.</p>
      ) : (
        <ul className="entity-list">
          {schema.tables.map((t) => (
            <li key={t.qualifiedName}>
              <a href={`/tables/${t.qualifiedName}`}>{t.label}</a>{' '}
              <code className="subtitle">{t.qualifiedName}</code>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
