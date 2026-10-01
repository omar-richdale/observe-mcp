#!/usr/bin/env node
/**
 * MCP server exposing OpenObserve logs — and optionally a read-only database —
 * as tools, so an assistant can answer "what happened in production?" without
 * ever being handed the credentials.
 *
 * Transport is line-delimited JSON-RPC 2.0 over stdio, which is what MCP clients
 * launch. Implemented directly against the protocol rather than through an SDK
 * so the package stays installable with one zero-dependency driver and nothing
 * else.
 *
 * Tool names mirror OpenObserve's enterprise MCP server (StreamList,
 * StreamSchema, SearchSQL) so prompts written for either one transfer unchanged.
 */
import { createInterface } from 'node:readline';
import { loadConfig, makeRedactor } from './config.mjs';
import { listStreams, search, streamSchema, toMicros } from './openobserve.mjs';
import { assertReadOnlySql, runReadOnly, SCHEMA_SQL } from './database.mjs';

const VERSION = '1.0.0';
const cfg = loadConfig();
const redact = makeRedactor(cfg);

/** Long log messages blow up a context window fast; keep a result set readable. */
function clampRows(rows, maxChars) {
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] =
        typeof v === 'string' && v.length > maxChars
          ? `${v.slice(0, maxChars)}…[+${v.length - maxChars} chars]`
          : v;
    }
    return out;
  });
}

const excludeHint = cfg.excludeIps.length
  ? ` This deployment has noise sources worth excluding; when a field holds a client IP, filter out ${cfg.excludeIps
      .map((ip) => `'${ip}'`)
      .join(', ')}.`
  : '';

const searchDescription = [
  'Run SQL against an OpenObserve stream and return the matching rows. The stream name is the FROM target.',
  '`start` and `end` accept an ISO timestamp, a plain date, epoch seconds/ms/µs, a relative offset like "-24h" or "-90m", or "now". They default to the last 24 hours.',
  'Bucket by time with histogram(_timestamp, \'1 hour\'). `_timestamp` is microseconds since the epoch.',
  'Call StreamList first if you do not know what exists, and StreamSchema before querying a stream whose fields you have not seen — field names differ per stream and guessing wastes a round trip.',
  'Beware that many log shippers emit SEVERAL rows per request (one per output line), so a naive count(*) overstates traffic. Check the schema for a status or level field and count only rows that carry one.',
  excludeHint,
  cfg.extraNotes ? ` Deployment notes: ${cfg.extraNotes}` : '',
]
  .filter(Boolean)
  .join(' ');

const TOOLS = {
  StreamList: {
    description:
      'List OpenObserve streams with document counts, stored size and the newest document timestamp. Start here when you do not know what data is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ streams: await listStreams(cfg) }),
  },

  StreamSchema: {
    description:
      'Field names and types for one OpenObserve stream. Call this before writing SQL against a stream you have not queried before.',
    inputSchema: {
      type: 'object',
      properties: { stream: { type: 'string', description: 'Stream name, as StreamList reports it.' } },
      required: ['stream'],
      additionalProperties: false,
    },
    run: async ({ stream }) => ({ stream, fields: await streamSchema(cfg, stream) }),
  },

  SearchSQL: {
    description: searchDescription,
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'e.g. SELECT level, count(*) AS n FROM my_stream GROUP BY level ORDER BY n DESC' },
        start: { type: 'string', description: 'Window start. Default -24h.' },
        end: { type: 'string', description: 'Window end. Default now.' },
        size: { type: 'number', description: 'Maximum rows to return. Default 50, maximum 1000.' },
        max_field_chars: { type: 'number', description: 'Truncate long string fields to this length. Default 400.' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    async run({ sql, start, end, size, max_field_chars }) {
      if (!sql || typeof sql !== 'string') throw new Error('sql is required');
      const startMicros = toMicros(start, Date.now() - 24 * 3600 * 1000);
      const endMicros = toMicros(end, Date.now());
      if (endMicros <= startMicros) throw new Error('end must be after start');
      const data = await search(cfg, {
        sql,
        startMicros,
        endMicros,
        size: Math.min(Math.max(Number(size) || 50, 1), 1000),
      });
      return {
        window: {
          start: new Date(startMicros / 1000).toISOString(),
          end: new Date(endMicros / 1000).toISOString(),
        },
        total: data.total,
        took_ms: data.took,
        hits: clampRows(data.hits ?? [], Math.max(Number(max_field_chars) || 400, 40)),
      };
    },
  },

  DbSchema: {
    description:
      'List the tables and columns this database connection can actually see. Grants are often narrower than the application schema, so check here rather than assuming a table exists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => runReadOnly(cfg.dbUrl, SCHEMA_SQL, { cap: 500, timeoutMs: cfg.dbTimeoutMs }),
  },

  DbQuery: {
    description: [
      'Run a read-only SQL query against the configured database, to correlate what the logs say with what the data says.',
      'Only a single SELECT or WITH statement is accepted, and it runs inside a READ ONLY transaction with a statement timeout.',
      'This may be production data holding real people\'s information: prefer aggregates, and do not select personal fields such as email addresses unless the question genuinely requires them.',
      'Call DbSchema first if you are unsure what tables and columns exist.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT or WITH statement.' },
        limit: { type: 'number', description: 'Maximum rows to return. Default 100, maximum 1000.' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    run: ({ sql, limit }) =>
      runReadOnly(cfg.dbUrl, assertReadOnlySql(sql), {
        cap: Math.min(Math.max(Number(limit) || 100, 1), 1000),
        timeoutMs: cfg.dbTimeoutMs,
      }),
  },
};

/** The database tools are only advertised when a database is configured. */
function visibleTools() {
  return Object.entries(TOOLS).filter(([name]) => (name.startsWith('Db') ? Boolean(cfg.dbUrl) : true));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'openobserve', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: visibleTools().map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    case 'tools/call': {
      const tool = TOOLS[params?.name];
      if (!tool) throw new Error(`Unknown tool: ${params?.name}`);
      const result = await tool.run(params?.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
    }
    case 'resources/list':
      return { resources: [] };
    case 'prompts/list':
      return { prompts: [] };
    default:
      throw new Error(`Unsupported method: ${method}`);
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // Policing the transport is not this server's job.
  }
  // A notification carries no id and must not be answered.
  if (req.id === undefined || req.id === null) return;
  try {
    send({ jsonrpc: '2.0', id: req.id, result: await handle(req.method, req.params) });
  } catch (err) {
    const message = redact(err?.message ?? err);
    // A failed tool call is a *result*, not a transport error: reporting it this
    // way lets the model read the message and fix its SQL instead of stalling.
    if (req.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: req.id, result: { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] } });
    } else {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message } });
    }
  }
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`observe-mcp: ${redact(err?.stack ?? err)}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`observe-mcp: ${redact(err?.stack ?? err)}\n`);
});
