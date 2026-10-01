/**
 * The read-only database half, used to correlate what the logs say with what the
 * data says.
 *
 * This points at a database that real users live in, so refusing writes is
 * layered rather than trusted to any single mechanism:
 *
 *   1. a single statement only — no semicolons;
 *   2. it must begin with SELECT or WITH;
 *   3. a keyword scan over the statement with string literals and comments
 *      stripped, because Postgres allows data-modifying CTEs
 *      (`WITH x AS (DELETE … RETURNING …)`) that pass check 2 happily;
 *   4. execution inside a READ ONLY transaction with a statement timeout.
 *
 * None of that replaces pointing O2_DB_URL at a role that only holds SELECT.
 * `verifyReadOnly` exists because a role's *name* proves nothing: a role created
 * through a managed provider's console may be granted a superuser-ish group
 * behind your back and have full write access while being called "read only".
 */

const FORBIDDEN = [
  'insert', 'update', 'delete', 'merge', 'upsert', 'truncate', 'drop', 'alter', 'create',
  'grant', 'revoke', 'comment', 'copy', 'call', 'do', 'vacuum', 'analyze', 'reindex',
  'cluster', 'refresh', 'listen', 'notify', 'unlisten', 'lock', 'prepare', 'execute',
  'deallocate', 'discard', 'set', 'reset', 'begin', 'start', 'commit', 'rollback',
  'savepoint', 'release', 'import', 'security', 'checkpoint',
];

/** Throws unless `raw` is a single, unmistakably read-only statement. */
export function assertReadOnlySql(raw) {
  const sql = String(raw ?? '').trim().replace(/;\s*$/, '');
  if (!sql) throw new Error('sql is required');
  if (sql.includes(';')) throw new Error('Multiple statements are not allowed; send a single SELECT.');
  if (!/^(select|with)\b/i.test(sql)) throw new Error('Only SELECT / WITH statements are allowed.');

  // Strip quoted text and comments first, so a legitimate
  // `WHERE message LIKE '%delete%'` is not mistaken for a DELETE, and a `--`
  // cannot hide a statement tail from the scan.
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$\$[\s\S]*?\$\$/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');

  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(stripped)) {
      throw new Error(`Rejected: "${word}" is not allowed in a read-only query.`);
    }
  }
  return sql;
}

let driver;
async function getDriver() {
  if (!driver) {
    try {
      driver = (await import('postgres')).default;
    } catch (err) {
      throw new Error(
        `Cannot load the "postgres" driver (${err.message}). Run \`npm install\` in the observe-mcp directory.`,
      );
    }
  }
  return driver;
}

export async function connect(dbUrl, { timeoutMs = 15000 } = {}) {
  if (!dbUrl) {
    throw new Error(
      'Database access is not configured. Set O2_DB_URL to a read-only Postgres URL, or re-run `npx observe-mcp-setup`.',
    );
  }
  const postgres = await getDriver();
  return postgres(dbUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 15,
    onnotice: () => {},
    connection: { statement_timeout: timeoutMs },
  });
}

/** Run an already-validated statement in a read-only transaction. */
export async function runReadOnly(dbUrl, sql, { cap = 100, timeoutMs = 15000 } = {}) {
  const pg = await connect(dbUrl, { timeoutMs });
  try {
    const rows = await pg.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx.unsafe(`SET LOCAL statement_timeout = ${Number(timeoutMs) || 15000}`);
      return tx.unsafe(sql);
    });
    const all = Array.from(rows);
    return { returned: Math.min(all.length, cap), total: all.length, truncated: all.length > cap, rows: all.slice(0, cap) };
  } finally {
    await pg.end({ timeout: 5 }).catch(() => {});
  }
}

export const SCHEMA_SQL = `select table_schema || '.' || table_name as "table",
       string_agg(column_name || ':' || data_type, ', ' order by ordinal_position) as columns
from information_schema.columns
where table_schema not in ('pg_catalog', 'information_schema')
group by 1 order by 1`;

/**
 * Prove the credential cannot write, instead of taking its name on trust.
 *
 * Every write probe runs inside a transaction that is always rolled back, and
 * the session's read-only default is deliberately switched off first — that
 * default is a settable parameter, not a privilege, so a client can defeat it.
 * What we want to know is whether the *grants* refuse the write.
 *
 * A caveat worth knowing: an unentitled GRANT does not raise an error in
 * Postgres. It returns success and emits `WARNING: no privileges were granted`,
 * so a GRANT probe is checked by re-reading has_table_privilege rather than by
 * whether the statement threw.
 */
export async function verifyReadOnly(dbUrl, { timeoutMs = 15000 } = {}) {
  const pg = await connect(dbUrl, { timeoutMs });
  const report = { ok: false, identity: {}, probes: [], warnings: [], tables: 0 };
  try {
    const [who] = await pg.unsafe('select current_user as role, current_database() as db, version() as version');
    report.identity = who;

    const [attrs] = await pg.unsafe(
      `select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin
       from pg_roles where rolname = current_user`,
    );
    report.identity.attributes = attrs ?? {};

    const memberships = await pg.unsafe(
      `select r.rolname as member_of from pg_auth_members m
       join pg_roles r on r.oid = m.roleid
       join pg_roles u on u.oid = m.member
       where u.rolname = current_user order by 1`,
    );
    report.identity.memberships = memberships.map((r) => r.member_of);

    const [ro] = await pg.unsafe('show default_transaction_read_only');
    report.identity.default_transaction_read_only = ro?.default_transaction_read_only;
    const [rec] = await pg.unsafe('select pg_is_in_recovery() as replica');
    report.identity.is_read_replica = rec?.replica === true;

    const [count] = await pg.unsafe(
      `select count(*)::int as n from information_schema.tables where table_schema not in ('pg_catalog','information_schema')`,
    );
    report.tables = count?.n ?? 0;

    // Pick a table we can actually see, plus one of its real, writable columns.
    // An UPDATE probe has to be valid SQL or it fails for the wrong reason and
    // proves nothing about privileges — `set ctid = ctid` is rejected as a
    // system column even for a role that holds UPDATE.
    const [target] = await pg.unsafe(
      `select c.table_schema as s, c.table_name as t, c.column_name as col
       from information_schema.columns c
       join information_schema.tables tb
         on tb.table_schema = c.table_schema and tb.table_name = c.table_name
       where c.table_schema not in ('pg_catalog','information_schema')
         and tb.table_type = 'BASE TABLE'
         and c.is_generated = 'NEVER'
         and c.is_updatable = 'YES'
       order by c.table_schema, c.table_name, c.ordinal_position
       limit 1`,
    );

    const c = await pg.reserve();
    try {
      // Defeat the session default on purpose: we are testing privileges.
      await c.unsafe('SET default_transaction_read_only = off').catch(() => {
        report.warnings.push('Could not switch off default_transaction_read_only; privilege probes may be masked by it.');
      });

      const probes = [];
      if (target) {
        const rel = `"${target.s}"."${target.t}"`;
        probes.push(
          ['UPDATE', `update ${rel} set "${target.col}" = "${target.col}" where false`],
          ['DELETE', `delete from ${rel} where false`],
          ['TRUNCATE', `truncate ${rel}`],
        );
      }
      probes.push(
        ['CREATE TABLE', 'create table observe_mcp_probe (x int)'],
        ['CREATE ROLE', "create role observe_mcp_probe_role login password 'x'"],
      );

      for (const [label, sql] of probes) {
        await c.unsafe('BEGIN READ WRITE').catch(() => {});
        let blocked;
        let detail;
        try {
          await c.unsafe(sql);
          blocked = false;
          detail = 'statement was accepted';
        } catch (err) {
          blocked = true;
          detail = String(err.message).split('\n')[0];
        }
        await c.unsafe('ROLLBACK').catch(() => {});
        // A probe that failed for a reason other than privilege proves nothing;
        // say so rather than counting it as evidence of being read-only.
        const inconclusive = blocked && !/permission denied|must be owner|read-only transaction|denied to create/i.test(detail);
        report.probes.push({ probe: label, blocked, inconclusive, detail });
      }

      if (target) {
        const rel = `"${target.s}"."${target.t}"`;
        await c.unsafe('BEGIN READ WRITE').catch(() => {});
        let escalated = false;
        try {
          await c.unsafe(`grant all on ${rel} to current_user`);
          const [p] = await c.unsafe(
            `select has_table_privilege(current_user, '${target.s}.${target.t}', 'INSERT') as g`,
          );
          escalated = p?.g === true;
        } catch {
          escalated = false;
        }
        await c.unsafe('ROLLBACK').catch(() => {});
        report.probes.push({
          probe: 'GRANT self INSERT',
          blocked: !escalated,
          inconclusive: false,
          detail: escalated ? 'privilege was actually granted' : 'no privileges were granted (expected)',
        });
      }
    } finally {
      await c.release();
    }

    const conclusive = report.probes.filter((p) => !p.inconclusive);
    report.ok = conclusive.length > 0 && conclusive.every((p) => p.blocked);

    if (report.identity.attributes?.rolsuper) report.warnings.push('This role is a Postgres SUPERUSER.');
    if (report.identity.attributes?.rolcreaterole) report.warnings.push('This role has CREATEROLE.');
    if (report.identity.attributes?.rolbypassrls) report.warnings.push('This role has BYPASSRLS.');
    if (report.identity.memberships?.length) {
      report.warnings.push(`Inherits from: ${report.identity.memberships.join(', ')} — check what those groups grant.`);
    }
    return report;
  } finally {
    await pg.end({ timeout: 5 }).catch(() => {});
  }
}
