#!/usr/bin/env node
/**
 * Guided setup. The point of a wizard rather than a page of documentation is
 * that each answer can be *checked* before the next question is asked: an
 * unreachable URL, a credential that does not authenticate, or a "read-only"
 * database role that can in fact write are all caught here rather than
 * discovered later by an assistant querying production.
 *
 * The read-only verification is not decoration. A role created through a managed
 * provider's web console may be auto-granted a superuser-ish group, leaving it
 * with full INSERT/UPDATE/DELETE while being called "read only" — so this proves
 * the grants refuse writes instead of trusting the role's name.
 *
 * `--doctor` re-runs every check against an existing configuration and changes
 * nothing.
 */
import { spawn } from 'node:child_process';
import { cwd, exit, platform, stdout } from 'node:process';
import { loadConfig } from './config.mjs';
import { fetchBuildInfo, listStreams, probeEnterpriseMcp } from './openobserve.mjs';
import { verifyReadOnly } from './database.mjs';
import { Prompter, detail, heading, icon, say, style } from './prompt.mjs';
import {
  buildClientConfig,
  CLIENT_CONFIG_PATHS,
  claudeCliAvailable,
  registerWithClaudeCli,
  serverEntryPoint,
  writeProjectMcpJson,
} from './register.mjs';

const SERVER_NAME = 'observe';
const doctorMode = process.argv.includes('--doctor');

function fail(message) {
  say(`\n${icon.bad} ${style.red(message)}`);
  exit(1);
}

// ---------------------------------------------------------------------------
// Checks, each usable by both the wizard and --doctor
// ---------------------------------------------------------------------------

async function checkInstance(url) {
  const info = await fetchBuildInfo(url);
  return {
    version: info.version ?? 'unknown',
    commit: info.commit_hash ? String(info.commit_hash).slice(0, 10) : null,
    built: info.build_date ?? null,
  };
}

async function checkCredentials(cfg) {
  const streams = await listStreams(cfg);
  return streams;
}

function printReadOnlyReport(report) {
  const a = report.identity.attributes ?? {};
  detail(`role: ${report.identity.role}   database: ${report.identity.db}`);
  detail(
    `superuser=${a.rolsuper ? 'YES' : 'no'}  createdb=${a.rolcreatedb ? 'YES' : 'no'}  ` +
      `createrole=${a.rolcreaterole ? 'YES' : 'no'}  bypassrls=${a.rolbypassrls ? 'YES' : 'no'}`,
  );
  detail(`inherits from: ${report.identity.memberships?.length ? report.identity.memberships.join(', ') : 'nothing'}`);
  detail(`default_transaction_read_only=${report.identity.default_transaction_read_only}  read replica=${report.identity.is_read_replica}`);
  detail(`tables visible: ${report.tables}`);
  say('');
  for (const p of report.probes) {
    const mark = p.inconclusive ? icon.warn : p.blocked ? icon.ok : icon.bad;
    const verdict = p.inconclusive ? 'inconclusive' : p.blocked ? 'refused' : style.red('ALLOWED');
    say(`  ${mark} ${p.probe.padEnd(18)} ${verdict}  ${style.dim(p.detail.slice(0, 80))}`);
  }
  for (const w of report.warnings) say(`  ${icon.warn} ${style.yellow(w)}`);
}

/** Launch the built server and speak MCP to it, so we know the real thing works. */
function smokeTestServer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverEntryPoint()], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, tools: [], error: `timed out${err ? `: ${err.trim().slice(0, 200)}` : ''}` });
    }, 45_000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            child.kill();
            resolve({ ok: true, tools: msg.result.tools.map((t) => t.name), error: null });
            return;
          }
        } catch {
          /* partial line */
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, tools: [], error: e.message });
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'setup', version: '1' } },
      })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  });
}

// ---------------------------------------------------------------------------
// --doctor
// ---------------------------------------------------------------------------
async function doctor() {
  heading('observe-mcp doctor');
  const cfg = loadConfig();
  if (!cfg.url) {
    fail('No configuration found in the environment. Run `npm run setup` first, or export O2_URL and friends.');
  }
  say(`${icon.info} instance ${cfg.url}  org ${cfg.org}`);

  try {
    const info = await checkInstance(cfg.url);
    say(`${icon.ok} reachable — OpenObserve ${info.version}${info.commit ? ` (${info.commit})` : ''}`);
  } catch (err) {
    say(`${icon.bad} unreachable: ${err.message}`);
  }

  try {
    const streams = await checkCredentials(cfg);
    say(`${icon.ok} credentials accepted — ${streams.length} stream(s) visible`);
    for (const s of streams.slice(0, 8)) detail(`${s.name} (${s.type}, ${s.docs ?? '?'} docs)`);
  } catch (err) {
    say(`${icon.bad} credential check failed: ${err.message}`);
  }

  if (cfg.dbUrl) {
    heading('Database');
    try {
      const report = await verifyReadOnly(cfg.dbUrl, { timeoutMs: cfg.dbTimeoutMs });
      printReadOnlyReport(report);
      say(report.ok ? `\n${icon.ok} ${style.green('database credential is read-only')}` : `\n${icon.bad} ${style.red('database credential CAN WRITE')}`);
    } catch (err) {
      say(`${icon.bad} database check failed: ${err.message}`);
    }
  } else {
    say(`\n${icon.info} no database configured (O2_DB_URL unset)`);
  }

  heading('Server');
  const smoke = await smokeTestServer({});
  say(smoke.ok ? `${icon.ok} server responds — tools: ${smoke.tools.join(', ')}` : `${icon.bad} server failed: ${smoke.error}`);
  say('');
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------
async function wizard() {
  const p = new Prompter();
  const existing = loadConfig();

  say('');
  say(style.bold('  observe-mcp setup'));
  say(style.dim('  Connects an MCP client to OpenObserve logs, and optionally to a read-only database.'));
  say(style.dim('  Nothing is written until the end, and secrets are never echoed or stored in this repo.'));

  // --- 1. instance -------------------------------------------------------
  heading('1. OpenObserve instance');
  let instance;
  const url = await p.ask('Base URL', {
    def: existing.url || 'https://',
    validate: (v) => (/^https?:\/\/[^\s]+\.[^\s]+/.test(v) ? null : 'Enter a full URL, e.g. https://o2.example.com'),
  });
  try {
    instance = await checkInstance(url);
    say(`  ${icon.ok} reachable — OpenObserve ${style.bold(instance.version)}${instance.commit ? style.dim(` (${instance.commit})`) : ''}`);
  } catch (err) {
    say(`  ${icon.warn} ${style.yellow(`could not read ${url}/config: ${err.message}`)}`);
    if (!(await p.confirm('Carry on anyway?', false))) fail('Stopped at your request.');
  }

  // --- 2. organisation & credentials ------------------------------------
  heading('2. Organization and credentials');
  detail('The org id is in your OpenObserve URL after /web/, and on Settings → Organizations.');
  const org = await p.ask('Organization id', { def: existing.org || 'default' });
  detail('Use your login email, and either your password or an API token.');
  const user = await p.ask('Login email', { def: existing.user });
  const token = await p.askSecret('Password or API token');

  const cfg = { ...existing, url, org, user, token };
  let streams = [];
  try {
    streams = await checkCredentials(cfg);
    say(`  ${icon.ok} authenticated — ${style.bold(String(streams.length))} stream(s) visible`);
    for (const s of streams.slice(0, 8)) detail(`${s.name} (${s.type}, ${s.docs ?? '?'} docs)`);
    if (streams.length > 8) detail(`… and ${streams.length - 8} more`);
  } catch (err) {
    say(`  ${icon.bad} ${style.red(err.message)}`);
    if (!(await p.confirm('Save this configuration anyway?', false))) fail('Stopped — nothing was saved.');
  }

  // Tell the user if they could be using the official server instead.
  const ent = await probeEnterpriseMcp(cfg);
  if (ent.available) {
    say(`  ${icon.info} This instance also exposes OpenObserve's own MCP server at ${cfg.url}/api/${cfg.org}/mcp.`);
    detail('That one is first-party and has more tools; this package remains useful for the database half.');
  } else if (/enterprise/i.test(ent.body)) {
    detail("This build has no built-in MCP server (it is enterprise-only), which is what this package is for.");
  }

  // --- 3. database ------------------------------------------------------
  heading('3. Database for correlation (optional)');
  detail('Lets the assistant check logs against your data. Use a role that can only SELECT.');
  let dbUrl = '';
  if (await p.confirm('Connect a database?', Boolean(existing.dbUrl))) {
    for (;;) {
      dbUrl = await p.askSecret('Read-only Postgres URL');
      say(`  ${icon.info} verifying that this credential cannot write…`);
      let report;
      try {
        report = await verifyReadOnly(dbUrl, { timeoutMs: existing.dbTimeoutMs });
      } catch (err) {
        say(`  ${icon.bad} ${style.red(`could not connect: ${err.message}`)}`);
        if (await p.confirm('Try a different URL?', true)) continue;
        dbUrl = '';
        break;
      }
      say('');
      printReadOnlyReport(report);
      if (report.ok) {
        say(`\n  ${icon.ok} ${style.green('Verified: this credential can read but not write.')}`);
        break;
      }
      say(`\n  ${icon.bad} ${style.red('This credential CAN WRITE to your database.')}`);
      detail('A role named "read only" is not necessarily read-only — some providers auto-grant');
      detail('a superuser group to roles created through their web console. Create the role in SQL:');
      say('');
      say(style.dim('    CREATE ROLE observer LOGIN PASSWORD \'…\';'));
      say(style.dim('    GRANT CONNECT ON DATABASE yourdb TO observer;'));
      say(style.dim('    GRANT USAGE ON SCHEMA public TO observer;'));
      say(style.dim('    GRANT SELECT ON ALL TABLES IN SCHEMA public TO observer;'));
      say(style.dim('    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO observer;'));
      say(style.dim('    ALTER ROLE observer SET default_transaction_read_only = on;'));
      say('');
      const choice = await p.choose('How would you like to proceed?', [
        { value: 'retry', label: 'Enter a different URL', hint: 'recommended' },
        { value: 'accept', label: 'Use it anyway', hint: 'the server still refuses writes, but this is your last line of defence' },
        { value: 'skip', label: 'Skip the database', hint: 'logs only' },
      ]);
      if (choice === 'retry') continue;
      if (choice === 'skip') dbUrl = '';
      break;
    }
  }

  // --- 4. extras --------------------------------------------------------
  heading('4. Query hints (optional)');
  detail('Noise sources the assistant should filter out — monitors, CI, your own crawlers.');
  const excludeIps = await p.ask('IPs to exclude, comma-separated', {
    def: existing.excludeIps.join(','),
    allowEmpty: true,
  });
  detail('Anything specific about your data that would otherwise take a few wasted queries to learn.');
  const extraNotes = await p.ask('Notes for the assistant', { def: existing.extraNotes, allowEmpty: true });

  // --- 5. register ------------------------------------------------------
  heading('5. Connect it to your client');
  const env = {
    O2_URL: url,
    O2_ORG: org,
    O2_USER: user,
    O2_TOKEN: token,
    ...(dbUrl ? { O2_DB_URL: dbUrl } : {}),
    ...(excludeIps ? { O2_EXCLUDE_IPS: excludeIps } : {}),
    ...(extraNotes ? { O2_EXTRA_NOTES: extraNotes } : {}),
  };
  const entry = serverEntryPoint();

  say(`  ${icon.info} verifying the server starts with this configuration…`);
  const smoke = await smokeTestServer(env);
  if (smoke.ok) say(`  ${icon.ok} server responds — tools: ${style.bold(smoke.tools.join(', '))}`);
  else say(`  ${icon.bad} ${style.red(`server did not start: ${smoke.error}`)}`);

  const cli = claudeCliAvailable();
  const routes = [];
  if (cli) {
    routes.push(
      { value: 'cli-local', label: `Claude Code, this project only`, hint: `claude ${cli} — secrets in ~/.claude.json` },
      { value: 'cli-user', label: 'Claude Code, all projects', hint: 'secrets in your user config' },
    );
  }
  routes.push(
    { value: 'project', label: 'Write .mcp.json here', hint: 'placeholders, safe to commit; you supply env vars' },
    { value: 'print', label: 'Just print the config', hint: 'for Claude Desktop, Cursor, VS Code…' },
  );
  say('');
  const route = await p.choose('How should it be registered?', routes);

  say('');
  if (route === 'cli-local' || route === 'cli-user') {
    const scope = route === 'cli-local' ? 'local' : 'user';
    const res = registerWithClaudeCli({
      name: SERVER_NAME,
      scope,
      env,
      command: process.execPath,
      args: [entry],
      cwd: cwd(),
    });
    if (res.ok) {
      say(`${icon.ok} ${style.green(`Registered as "${SERVER_NAME}" at ${scope} scope.`)}`);
      if (res.stdout) detail(res.stdout.split('\n')[0]);
    } else {
      say(`${icon.bad} ${style.red('claude mcp add failed.')}`);
      if (res.stderr) detail(res.stderr.slice(0, 300));
      if (res.error) detail(res.error);
      say('\nRegister it by hand with this config:');
      say(JSON.stringify(buildClientConfig({ name: SERVER_NAME, env, command: process.execPath, args: [entry] }), null, 2));
    }
  } else if (route === 'project') {
    const file = writeProjectMcpJson({
      projectDir: cwd(),
      name: SERVER_NAME,
      env,
      command: process.execPath,
      args: [entry],
    });
    say(`${icon.ok} Wrote ${file} using \${VAR} placeholders — no secrets in it.`);
    say('\nExport these in the environment your client runs in:');
    for (const key of Object.keys(env)) {
      const secret = key === 'O2_TOKEN' || key === 'O2_DB_URL';
      say(`  ${key}=${secret ? style.dim('<the value you just entered>') : env[key]}`);
    }
  } else {
    say('Paste this into your client\'s config file:');
    say('');
    say(JSON.stringify(buildClientConfig({ name: SERVER_NAME, env, command: process.execPath, args: [entry] }), null, 2));
    say('');
    say(style.bold('Common locations'));
    for (const [client, path] of Object.entries(CLIENT_CONFIG_PATHS)) detail(`${client}: ${path}`);
  }

  // --- done -------------------------------------------------------------
  heading('Done');
  say(`Tools: ${style.bold('StreamList')}, ${style.bold('StreamSchema')}, ${style.bold('SearchSQL')}${dbUrl ? `, ${style.bold('DbSchema')}, ${style.bold('DbQuery')}` : ''}`);
  if (!dbUrl) detail('Database tools are hidden until a database is configured — re-run setup to add one.');
  say('');
  say('Restart your MCP client so it picks up the new server, then try:');
  detail('"List the OpenObserve streams and tell me which ones are still receiving data."');
  if (dbUrl) detail('"Compare today\'s signup errors in the logs against the rows actually created."');
  say('');
  say(`Re-check anything later with ${style.cyan('npm run doctor')}.`);
  if (platform === 'win32') detail('On Windows, run that from the same shell where your env vars are set.');
  say('');
  p.close();
}

try {
  if (doctorMode) await doctor();
  else await wizard();
} catch (err) {
  // Ctrl-D, or a piped answer file that ran out before the last question.
  if (err?.code === 'INPUT_ENDED' || err?.code === 'ERR_USE_AFTER_CLOSE') {
    stdout.write(`\n${icon.warn} ${err.message ?? 'Input ended.'} Nothing was saved.\n`);
    exit(130);
  }
  stdout.write(`\n${icon.bad} ${err?.stack ?? err}\n`);
  exit(1);
}
