# observe-mcp

An MCP server that lets Claude answer **"what actually happened in production?"** — by
reading your [OpenObserve](https://openobserve.ai) logs and, optionally, correlating them
against your database through a strictly read-only connection.

```
You:    Why did signups drop this morning?
Claude: [SearchSQL]  → 14 signup requests returned 500 between 09:30 and 10:40
        [SearchSQL]  → all of them log "INTERNAL_SECRET is not set"
        [DbQuery]    → 9 users created today, 0 with a subscription
        A deploy at 10:42 fixed it. Three verified users bounced off in between.
```

Setup is a guided wizard that validates every answer before saving it, including
**proving that your "read-only" database credential genuinely cannot write.**

---

## Why this exists

OpenObserve ships its own MCP server, but on open-source builds it answers:

```json
{"error":"MCP server is only available in enterprise edition"}
```

The ordinary search API is available on *every* edition. This package wraps that, and
keeps the same tool names as the enterprise server (`StreamList`, `StreamSchema`,
`SearchSQL`) so prompts and habits transfer if you later license it. It then adds the
half the enterprise server does not have: a read-only SQL tool for correlating logs
against the data they describe.

The wizard will tell you if your instance *does* expose the official server, so you can
use the first-party one instead.

---

## Install

Requires **Node 20 or newer**. Works on Linux, macOS and Windows.

```bash
git clone <this repo> observe-mcp
cd observe-mcp
npm install
npm run setup
```

The wizard asks for:

| | |
|---|---|
| **OpenObserve URL** | checked for reachability, and reports your build version |
| **Organization id** | from your OpenObserve URL after `/web/`, or Settings → Organizations |
| **Login email + password or token** | verified by listing your streams before anything is saved |
| **Database URL** *(optional)* | **verified to be read-only** — see below |
| **Traffic to ignore** *(optional)* | monitors, QA runners, CI, your own crawlers — so they stop skewing counts |
| **Notes** *(optional)* | anything about your data that would otherwise cost the assistant a few wasted queries |

Then it shows you everything for review, registers the server with your client,
smoke-tests it by speaking MCP to the real process, and prints what to try first.

Nothing is written until you confirm, and secrets are never echoed to the terminal or
stored anywhere in this repo.

### Changing your mind

Type **`back`** (or `<`) at any question to return to the previous one; answers you have
already given come back as the defaults. Before anything is saved you get a review
screen, where **Change one of the answers above** re-runs just that step:

```
Review
  1. OpenObserve instance           https://o2.example.com
  2. Organization and credentials   default as me@example.com
  3. Database for correlation       configured, verified read-only
  4. Traffic to ignore              10.0.0.5 (ci.example.com)
  5. Notes for the assistant        (none)

  → 1. Save and register — nothing has been written yet
    2. Change one of the answers above
    3. Cancel — discard everything
```

Re-running `npm run setup` later picks up your current configuration as the defaults, so
it doubles as an edit command.

### Traffic to ignore

Monitors, QA runners and CI inflate request counts and unique-visitor counts, and the
inflation is worst exactly when you are trying to work out whether something is wrong.

You can give **hostnames as well as addresses** — hostnames are what you actually know
your own machines by — and they are resolved for you at setup time:

```
Excluded:
  • 203.0.113.10 o2.example.com — the host your OpenObserve instance runs on

Keep these excluded? (Y/n)
Exclude anything else? (y/N) y
Addresses or hostnames: qa.example.com, 10.0.0.5
  ✓ 198.51.100.7 (qa.example.com)
  ✓ 10.0.0.5
```

The package ships no built-in list — one deployment's monitor is another's real user. The
single suggestion is derived from the instance you are configuring: the box running your
observability stack is very often the box running your scheduled jobs too. An entry that
fails to resolve is reported rather than silently dropped, because a typo in an exclusion
list is invisible later — the counts are simply wrong.

### Scripted / unattended setup

The wizard reads piped input, so it can be driven from a file or in CI:

```bash
printf '%s\n' "https://o2.example.com" "default" "me@example.com" "$O2_TOKEN" \
              "y" "$READONLY_DB_URL" "" "" "4" | npm run setup
```

Or skip it entirely and set the environment variables yourself (see
[Configuration](#configuration)).

---

## The read-only guarantee

> A role called "read only" is not necessarily read-only.

Managed Postgres providers often auto-grant a privileged group to roles created through
their web console. A role can be named `Read_Only_role`, be created expressly for
read-only access, and still hold `INSERT`, `UPDATE`, `DELETE` and `BYPASSRLS` — this is
not hypothetical, it is why the verification step exists.

So setup proves it instead of trusting the name. It reports the role's attributes and
group memberships, then **deliberately switches off the session's read-only default**
— that is a settable parameter, not a privilege, and any client can turn it off — and
attempts a write under `BEGIN READ WRITE`:

```
  role: observer   database: appdb
  superuser=no  createdb=no  createrole=no  bypassrls=no
  inherits from: nothing
  default_transaction_read_only=on  read replica=false
  tables visible: 27

  ✓ UPDATE             refused  permission denied for table …
  ✓ DELETE             refused  permission denied for table …
  ✓ TRUNCATE           refused  permission denied for table …
  ✓ CREATE TABLE       refused  permission denied for schema public
  ✓ CREATE ROLE        refused  permission denied to create role
  ✓ GRANT self INSERT  refused  no privileges were granted (expected)

✓ database credential is read-only
```

Every probe runs inside a transaction that is always rolled back. A probe that fails for
any reason *other* than a privilege denial is reported as **inconclusive** rather than
counted as evidence — a write that fails because the SQL was invalid proves nothing.

The `GRANT` probe is checked by re-reading `has_table_privilege`, not by whether the
statement threw: an unentitled `GRANT` in Postgres **returns success** and only emits
`WARNING: no privileges were granted`, so a naive check reports a no-op as an escalation.

If verification fails, the wizard shows you the SQL to create a proper role and offers to
retry.

### Creating a genuinely read-only role

Run this as the database owner, **in a SQL client rather than your provider's "add role"
button** — roles created in SQL get no automatic group membership:

```sql
CREATE ROLE observer LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE yourdb TO observer;
GRANT USAGE ON SCHEMA public TO observer;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO observer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO observer;
ALTER ROLE observer SET default_transaction_read_only = on;
```

`ALTER DEFAULT PRIVILEGES` only covers tables created by the role that runs it, so run it
as whoever owns your application's tables.

Stronger still, if your provider offers it: point `O2_DB_URL` at a **read replica**
endpoint. Those reject writes at the compute layer, so no grant mistake can matter. The
verifier reports `read replica=true` when it detects one.

---

## Tools

| Tool | What it does |
|---|---|
| `StreamList` | Streams with document counts, size, newest timestamp. Start here. |
| `StreamSchema` | Field names and types for one stream. |
| `SearchSQL` | SQL over a stream, with a time window. |
| `DbSchema` | Tables and columns the connection can actually see. |
| `DbQuery` | A single read-only `SELECT` / `WITH`. |

`DbSchema` and `DbQuery` are hidden entirely unless a database is configured.

Time windows accept whatever you would naturally type: `-24h`, `-90m`, `now`,
`2026-10-01`, an ISO timestamp, or epoch seconds/ms/µs. They default to the last 24 hours.

### How `DbQuery` refuses writes

Four layers, because the one that matters most is the one you control:

1. a single statement — no semicolons;
2. it must begin with `SELECT` or `WITH`;
3. a keyword scan with string literals and comments stripped first — Postgres allows
   data-modifying CTEs like `WITH x AS (DELETE … RETURNING …)` that sail past step 2,
   while a legitimate `WHERE msg LIKE '%delete%'` must still work;
4. execution inside a `READ ONLY` transaction with a statement timeout.

None of this replaces a read-only role. It is the belt for that braces.

---

## Configuration

Set by the wizard, or exported yourself:

| Variable | Required | Meaning |
|---|---|---|
| `O2_URL` | yes | Base URL, e.g. `https://o2.example.com` |
| `O2_ORG` | yes | Organization id |
| `O2_USER` | yes | Login email |
| `O2_TOKEN` | yes | Password or API token |
| `O2_DB_URL` | no | Read-only Postgres URL; omit to disable the database tools |
| `O2_EXCLUDE_IPS` | no | Comma-separated IPs the assistant should filter out |
| `O2_EXTRA_NOTES` | no | Deployment notes injected into the `SearchSQL` description |
| `O2_DB_TIMEOUT_MS` | no | Statement timeout, default `15000` |
| `O2_ENV_FILE` | no | Path to a `KEY=value` file to read as a fallback (local development) |

`OPENOBSERVE_*` names are accepted as aliases, so an existing `.env` works unchanged.
The real environment always wins over a file, so a secret passed at registration time is
never shadowed by a stale copy.

### Where your secrets end up

The wizard offers four routes, which differ only in that:

- **Claude Code, this project / all projects** — `claude mcp add --scope local|user`.
  Secrets go in your own Claude config, outside the project. **Preferred.**
- **Write `.mcp.json` here** — committable, because it is written with `${VAR}`
  placeholders rather than values. You supply the variables in the environment.
- **Just print the config** — for Claude Desktop, Cursor, VS Code and friends, with the
  usual file locations listed.

### Codex CLI

MCP is an open protocol, so this is not Claude-only. Codex takes it directly:

```bash
codex mcp add observe \
  --env O2_URL=https://o2.example.com --env O2_ORG=default \
  --env O2_USER=you@example.com --env O2_TOKEN=… --env O2_DB_URL=… \
  -- node /path/to/observe-mcp/src/server.mjs
```

Verified against codex-cli 0.159.2: all five tools are discovered and callable, and
`DbQuery` still refuses a write. One Codex quirk — `codex exec` runs with
`approval: never`, so MCP calls are blocked there unless you pass
`--dangerously-bypass-approvals-and-sandbox`. Interactive `codex` prompts for approval
normally.

This repo never stores credentials. `.gitignore` covers `.env` and `.mcp.json` anyway.

---

## Checking and troubleshooting

```bash
npm run doctor   # re-run every check against the current configuration; changes nothing
npm test         # protocol and SQL-gate tests; no live services needed
```

`doctor` verifies reachability, credentials, the read-only guarantee, and that the server
starts and lists its tools.

| Symptom | Cause |
|---|---|
| `Cannot find module 'C:\\C:\\…'` | Fixed in 1.0.1 — update, or re-run setup to rewrite the config |
| `HTTP 401` / `403` | Wrong `O2_USER` / `O2_TOKEN`, or the credential belongs to another org |
| `HTTP 404` on search | Wrong `O2_ORG`, or the stream does not exist — run `StreamList` |
| `MCP server is only available in enterprise edition` | Expected on OSS builds; it is why this package exists |
| `Cannot load the "postgres" driver` | Run `npm install` in this directory |
| Tools missing in the client | Restart the client; it reads MCP config at startup |
| `Db*` tools missing | No `O2_DB_URL` configured — re-run setup |

### Counting traffic correctly

Many log shippers emit **several rows per request** — one per output line — so a naive
`count(*)` overstates traffic, sometimes by more than 2×. Check the schema for a status
or level field and count only rows that carry one. The `SearchSQL` description tells the
model this, but it is worth knowing yourself when you check its work.

Unique-visitor counts have the mirror-image problem: crawlers inflate distinct-IP counts
badly. Classify on the user-agent field before calling them users.

---

## Licence

MIT.
