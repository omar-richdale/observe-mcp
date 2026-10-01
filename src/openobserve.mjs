/**
 * Thin client over the OpenObserve HTTP API.
 *
 * Why not OpenObserve's own MCP server: on open-source builds
 * `POST /api/<org>/mcp` answers 404 `{"error":"MCP server is only available in
 * enterprise edition"}`. The plain search API is available on every edition, so
 * this wraps that and keeps the enterprise tool names, meaning prompts written
 * against either one transfer unchanged.
 */
import { basicAuth, missingO2Keys } from './config.mjs';

export class OpenObserveError extends Error {}

function assertConfigured(cfg) {
  const missing = missingO2Keys(cfg);
  if (missing.length) {
    throw new OpenObserveError(
      `OpenObserve is not configured: missing ${missing.join(', ')}. ` +
        'Run `npx observe-mcp-setup` to configure it.',
    );
  }
}

async function request(cfg, path, init = {}) {
  assertConfigured(cfg);
  const url = `${cfg.url}/api/${encodeURIComponent(cfg.org)}${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: basicAuth(cfg), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new OpenObserveError(`Cannot reach OpenObserve at ${cfg.url}: ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? ' — check O2_USER / O2_TOKEN, and that the credential belongs to this organization'
        : res.status === 404
          ? ' — check O2_ORG and the stream name'
          : '';
    throw new OpenObserveError(`OpenObserve HTTP ${res.status}${hint}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenObserveError(`OpenObserve returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** Unauthenticated build info. Used by setup to confirm a URL before asking for secrets. */
export async function fetchBuildInfo(baseUrl) {
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/config`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new OpenObserveError(`GET /config returned HTTP ${res.status}`);
  return res.json();
}

/** Does this build expose the official enterprise MCP server? */
export async function probeEnterpriseMcp(cfg) {
  try {
    const res = await fetch(`${cfg.url}/api/${encodeURIComponent(cfg.org)}/mcp`, {
      method: 'POST',
      headers: { Authorization: basicAuth(cfg), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'observe-mcp-setup', version: '1' } },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    return { available: res.ok, status: res.status, body: body.slice(0, 200) };
  } catch (err) {
    return { available: false, status: 0, body: err.message };
  }
}

export async function listStreams(cfg) {
  const data = await request(cfg, '/streams');
  return (data.list ?? [])
    .map((s) => ({
      name: s.name,
      type: s.stream_type,
      docs: s.stats?.doc_num,
      size_mb: s.stats?.storage_size,
      newest: s.stats?.doc_time_max,
    }))
    .sort((a, b) => (b.docs ?? 0) - (a.docs ?? 0));
}

export async function streamSchema(cfg, stream) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(stream ?? ''))) {
    throw new OpenObserveError('Invalid stream name');
  }
  const data = await request(cfg, `/streams/${encodeURIComponent(stream)}/schema`);
  return (data.schema ?? []).map((f) => `${f.name}:${f.type}`);
}

export async function search(cfg, { sql, startMicros, endMicros, size }) {
  const data = await request(cfg, '/_search', {
    method: 'POST',
    body: JSON.stringify({
      query: { sql, start_time: startMicros, end_time: endMicros, from: 0, size },
    }),
  });
  return data;
}

/**
 * Time windows accept whatever a person would naturally type: an ISO timestamp,
 * a plain date, epoch seconds/ms/µs, a relative offset, or "now".
 */
export function toMicros(value, fallbackMs) {
  if (value === undefined || value === null || value === '') return Math.floor(fallbackMs * 1000);
  const s = String(value).trim();
  if (s === 'now') return Date.now() * 1000;
  const rel = /^-\s*(\d+)\s*([smhdw])$/i.exec(s);
  if (rel) {
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[rel[2].toLowerCase()];
    return (Date.now() - Number(rel[1]) * unit) * 1000;
  }
  if (/^\d{16}$/.test(s)) return Number(s);
  if (/^\d{13}$/.test(s)) return Number(s) * 1000;
  if (/^\d{10}$/.test(s)) return Number(s) * 1e6;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    throw new OpenObserveError(
      `Unparseable time ${JSON.stringify(s)}. Use an ISO timestamp, a date, epoch ms, a relative offset like "-24h", or "now".`,
    );
  }
  return t * 1000;
}
