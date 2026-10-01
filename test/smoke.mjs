/**
 * Protocol and guard tests that need no live OpenObserve or database.
 *
 * The read-only SQL gate is the part worth testing hardest: it is the last thing
 * between a model's generated SQL and a production database, and the interesting
 * bypasses (data-modifying CTEs, keywords hidden in string literals or comments)
 * all look like ordinary SELECTs at a glance.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { assertReadOnlySql } from '../src/database.mjs';
import { loadConfig, parseEnvFile } from '../src/config.mjs';
import { toMicros } from '../src/openobserve.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function rejects(sql, because) {
  assert.throws(() => assertReadOnlySql(sql), undefined, `should reject (${because}): ${sql}`);
}

console.log('\nread-only SQL gate');
test('accepts a plain SELECT', () => assertReadOnlySql('select 1'));
test('accepts a WITH query', () => assertReadOnlySql('with a as (select 1 x) select * from a'));
test('accepts a trailing semicolon', () => assertReadOnlySql('select 1;'));
test('accepts keywords inside string literals', () =>
  assertReadOnlySql("select count(*) from t where msg like '%delete from%' and s = 'drop table'"));
test('accepts a quoted identifier named like a keyword', () => assertReadOnlySql('select "update" from t'));
test('rejects INSERT', () => rejects('insert into t values (1)', 'write'));
test('rejects UPDATE', () => rejects('update t set x = 1', 'write'));
test('rejects DELETE', () => rejects('delete from t', 'write'));
test('rejects DROP', () => rejects('drop table t', 'DDL'));
test('rejects TRUNCATE', () => rejects('truncate t', 'DDL'));
test('rejects a data-modifying CTE', () =>
  rejects('with x as (delete from users returning id) select * from x', 'CTE write'));
test('rejects an INSERT-returning CTE', () =>
  rejects('with x as (insert into t values (1) returning id) select * from x', 'CTE write'));
test('rejects stacked statements', () => rejects('select 1; drop table t', 'two statements'));
test('rejects a write hidden after a line comment', () =>
  rejects('select 1 -- \n , (select 1) ; delete from t', 'comment smuggling'));
test('rejects SET', () => rejects('set role postgres', 'session change'));
test('rejects GRANT', () => rejects('grant all on t to public', 'privilege change'));
test('rejects an empty query', () => rejects('', 'empty'));
test('rejects a CALL', () => rejects('call do_something()', 'procedure'));

console.log('\ntime parsing');
test('relative hours', () => {
  const v = toMicros('-2h', Date.now());
  const expected = (Date.now() - 2 * 3600 * 1000) * 1000;
  assert.ok(Math.abs(v - expected) < 5e6, `got ${v}`);
});
test('plain date is treated as UTC midnight', () =>
  assert.equal(toMicros('2026-10-01', 0), Date.parse('2026-10-01T00:00:00Z') * 1000));
test('epoch milliseconds', () => assert.equal(toMicros('1790851347022', 0), 1790851347022 * 1000));
test('epoch microseconds pass through', () => assert.equal(toMicros('1790851347022209', 0), 1790851347022209));
test('"now" is roughly now', () => assert.ok(Math.abs(toMicros('now', 0) - Date.now() * 1000) < 5e6));
test('garbage is rejected', () => assert.throws(() => toMicros('last tuesday', 0)));

console.log('\nconfig');
test('parses quotes, export and BOM', () => {
  const env = parseEnvFile('﻿export A="one"\nB=\'two\'\nC=three#notcomment\n\n# comment\nD=\n');
  assert.equal(env.A, 'one');
  assert.equal(env.B, 'two');
  assert.equal(env.C, 'three#notcomment');
  assert.equal(env.D, '');
});
test('accepts OPENOBSERVE_* aliases', () => {
  const cfg = loadConfig({ OPENOBSERVE_BASE_URL: 'https://x.test/', OPENOBSERVE_ORG: 'o' });
  assert.equal(cfg.url, 'https://x.test');
  assert.equal(cfg.org, 'o');
});
test('strips trailing slashes from the URL', () =>
  assert.equal(loadConfig({ O2_URL: 'https://x.test///' }).url, 'https://x.test'));
test('splits exclude IPs', () =>
  assert.deepEqual(loadConfig({ O2_EXCLUDE_IPS: ' 1.1.1.1 , 2.2.2.2 ,' }).excludeIps, ['1.1.1.1', '2.2.2.2']));

// --- protocol -------------------------------------------------------------
const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

function rpc(requests, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, O2_URL: '', O2_ORG: '', O2_USER: '', O2_TOKEN: '', O2_DB_URL: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages = [];
    let buf = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(messages);
    }, 15_000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
      if (messages.length >= requests.filter((r) => r.id !== undefined).length) {
        clearTimeout(timer);
        child.kill();
        resolve(messages);
      }
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
  });
}

console.log('\nMCP protocol');
const msgs = await rpc([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'SearchSQL', arguments: { sql: 'select 1' } } },
]);

test('initialize returns a protocol version', () => {
  const m = msgs.find((x) => x.id === 1);
  assert.ok(m?.result?.protocolVersion, 'no protocolVersion');
  assert.equal(m.result.serverInfo.name, 'openobserve');
});
test('notifications get no reply', () => assert.ok(!msgs.some((m) => m.id === undefined && m.result)));
test('tools/list omits Db tools when no database is configured', () => {
  const names = msgs.find((x) => x.id === 2)?.result?.tools?.map((t) => t.name) ?? [];
  assert.deepEqual(names, ['StreamList', 'StreamSchema', 'SearchSQL']);
});
test('an unconfigured call fails as a tool result, not a transport error', () => {
  const m = msgs.find((x) => x.id === 3);
  assert.ok(m?.result?.isError, 'expected isError result');
  assert.match(m.result.content[0].text, /not configured/i);
});
const withDb = await rpc(
  [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
  { O2_DB_URL: 'postgresql://user:pw@localhost:5432/db' },
);
test('tools/list includes Db tools when a database is configured', () => {
  const names = withDb.find((x) => x.id === 1)?.result?.tools?.map((t) => t.name) ?? [];
  assert.deepEqual(names, ['StreamList', 'StreamSchema', 'SearchSQL', 'DbSchema', 'DbQuery']);
});

console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
