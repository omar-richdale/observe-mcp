/**
 * One place that decides what the server is configured to do, so the server and
 * the setup wizard can never disagree about it.
 *
 * Everything arrives through the environment, which is what lets the wizard put
 * secrets in the MCP client's own config file instead of a dotfile in the repo.
 * O2_ENV_FILE exists for local development only and is never written by setup.
 */
import { readFileSync } from 'node:fs';

export const ENV_KEYS = {
  O2_URL: 'OpenObserve base URL, e.g. https://o2.example.com',
  O2_ORG: 'OpenObserve organization id',
  O2_USER: 'OpenObserve login email',
  O2_TOKEN: 'OpenObserve password or API token',
  O2_DB_URL: 'Optional read-only Postgres URL for correlation queries',
  O2_EXCLUDE_IPS: 'Optional comma-separated IPs to suggest filtering out (bots, CI, your own monitors)',
  O2_EXTRA_NOTES: 'Optional deployment-specific guidance injected into the SearchSQL tool description',
  O2_DB_TIMEOUT_MS: 'Optional statement timeout for database queries (default 15000)',
  O2_ENV_FILE: 'Optional path to a KEY=value file to read as a fallback (local development)',
};

/** Accept the names OpenObserve's own tooling uses, so an existing .env works. */
const ALIASES = {
  OPENOBSERVE_URL: 'O2_URL',
  OPENOBSERVE_BASE_URL: 'O2_URL',
  OPENOBSERVE_ORG: 'O2_ORG',
  OPENOBSERVE_ORGANIZATION: 'O2_ORG',
  OPENOBSERVE_USER: 'O2_USER',
  OPENOBSERVE_EMAIL: 'O2_USER',
  OPENOBSERVE_TOKEN: 'O2_TOKEN',
  OPENOBSERVE_PASSWORD: 'O2_TOKEN',
  ZO_ROOT_USER_EMAIL: 'O2_USER',
  ZO_ROOT_USER_PASSWORD: 'O2_TOKEN',
};

/** Hand-written env files carry BOMs, quotes, `export `, and values containing '=' and '#'. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).replace(/^﻿/, '').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return out;
}

export function loadConfig(env = process.env) {
  const merged = { ...env };
  if (merged.O2_ENV_FILE) {
    let text = '';
    try {
      text = readFileSync(merged.O2_ENV_FILE, 'utf8');
    } catch (err) {
      process.stderr.write(`observe-mcp: cannot read O2_ENV_FILE: ${err.message}\n`);
    }
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      // The real environment always wins, so a secret passed at registration
      // time is never silently shadowed by a stale file.
      if (merged[key] === undefined) merged[key] = value;
      const alias = ALIASES[key];
      if (alias && !merged[alias] && value) merged[alias] = value;
    }
  }
  for (const [from, to] of Object.entries(ALIASES)) {
    if (!merged[to] && merged[from]) merged[to] = merged[from];
  }

  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

  return {
    url: String(merged.O2_URL ?? '').trim().replace(/\/+$/, ''),
    org: String(merged.O2_ORG ?? '').trim(),
    user: String(merged.O2_USER ?? '').trim(),
    token: String(merged.O2_TOKEN ?? ''),
    dbUrl: String(merged.O2_DB_URL ?? '').trim(),
    excludeIps: String(merged.O2_EXCLUDE_IPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    extraNotes: String(merged.O2_EXTRA_NOTES ?? '').trim(),
    dbTimeoutMs: num(merged.O2_DB_TIMEOUT_MS, 15000),
  };
}

export function missingO2Keys(cfg) {
  return [
    ['O2_URL', cfg.url],
    ['O2_ORG', cfg.org],
    ['O2_USER', cfg.user],
    ['O2_TOKEN', cfg.token],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

export function basicAuth(cfg) {
  return `Basic ${Buffer.from(`${cfg.user}:${cfg.token}`).toString('base64')}`;
}

/**
 * Redact every known secret from a string before it can reach a log line or a
 * tool result. Longest first, so a short secret that happens to be a substring
 * of a longer one cannot leave a partial value behind.
 */
export function makeRedactor(cfg) {
  const secrets = [cfg.token, cfg.dbUrl]
    .filter((s) => s && s.length >= 6)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text ?? '');
    for (const s of secrets) out = out.split(s).join('<redacted>');
    return out.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgresql://<redacted>');
  };
}
