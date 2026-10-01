/**
 * Register the server with an MCP client.
 *
 * Preference order matters for where secrets end up. `claude mcp add --scope
 * local|user` stores them in the user's own Claude config outside the project,
 * which is the only option here that keeps a credential out of a file someone
 * might commit. A project-scoped `.mcp.json` is offered too, but written with
 * `${VAR}` placeholders rather than values, so the file is safe to check in and
 * the secrets stay in the environment.
 *
 * On Windows the `claude` entry point is a `.cmd` shim, which cannot be executed
 * without a shell; spawn therefore uses a shell on win32 only, and arguments go
 * through an allow-listed quoting step rather than naive interpolation.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';

export function claudeCliAvailable() {
  const probe = spawnSync(isWindows ? 'claude.cmd' : 'claude', ['--version'], {
    shell: isWindows,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (probe.error || probe.status !== 0) return null;
  return String(probe.stdout || '').trim();
}

/**
 * Windows shells re-parse the command line, so anything handed to a shelled
 * spawn needs quoting. Values here are URLs, ids and secrets; a double-quote or
 * backtick in one would otherwise change the command.
 */
function quoteForWindows(arg) {
  if (/^[A-Za-z0-9_@%+=:,.\/\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["^&|<>`])/g, '^$1').replace(/\\$/, '\\\\')}"`;
}

export function registerWithClaudeCli({ name, scope, env, command, args, cwd }) {
  const cliArgs = ['mcp', 'add', name, '--scope', scope];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null || value === '') continue;
    cliArgs.push('-e', `${key}=${value}`);
  }
  cliArgs.push('--', command, ...args);

  // Replacing an existing entry is expected on re-run; a failure here is fine.
  spawnSync(isWindows ? 'claude.cmd' : 'claude', ['mcp', 'remove', name, '--scope', scope], {
    shell: isWindows,
    encoding: 'utf8',
    timeout: 30_000,
  });

  const result = spawnSync(
    isWindows ? 'claude.cmd' : 'claude',
    isWindows ? cliArgs.map(quoteForWindows) : cliArgs,
    { shell: isWindows, encoding: 'utf8', timeout: 60_000, cwd },
  );
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error ? result.error.message : null,
  };
}

/**
 * The config block to paste into a client that has no CLI (Claude Desktop,
 * Cursor, VS Code, Windsurf…). `mode: "values"` inlines the secrets — only for
 * a file the user keeps private. `mode: "placeholders"` emits `${VAR}` instead,
 * for anything that might be committed.
 */
export function buildClientConfig({ name, env, command, args, mode = 'values' }) {
  const envBlock = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null || value === '') continue;
    envBlock[key] = mode === 'placeholders' ? `\${${key}}` : value;
  }
  return { mcpServers: { [name]: { command, args, env: envBlock } } };
}

/** Write a project-scoped .mcp.json with placeholders, merging into any existing one. */
export function writeProjectMcpJson({ projectDir, name, env, command, args }) {
  const file = join(projectDir, '.mcp.json');
  let existing = {};
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} exists but is not valid JSON; fix or move it first.`);
    }
  }
  const block = buildClientConfig({ name, env, command, args, mode: 'placeholders' });
  const merged = {
    ...existing,
    mcpServers: { ...(existing.mcpServers ?? {}), ...block.mcpServers },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Where this installation lives, so the generated config points at the right
 * file. Must go through fileURLToPath: a file URL's `pathname` is `/C:/…` on
 * Windows, and passing that to resolve() yields `C:\\C:\\…` because resolve
 * reads the leading slash as "root of the current drive".
 */
export function serverEntryPoint() {
  return fileURLToPath(new URL('./server.mjs', import.meta.url));
}

/** Default config-file locations, shown as guidance rather than written to. */
export const CLIENT_CONFIG_PATHS = {
  'Claude Desktop (macOS)': '~/Library/Application Support/Claude/claude_desktop_config.json',
  'Claude Desktop (Windows)': '%APPDATA%\\Claude\\claude_desktop_config.json',
  'Claude Desktop (Linux)': '~/.config/Claude/claude_desktop_config.json',
  Cursor: '~/.cursor/mcp.json',
  'VS Code (workspace)': '.vscode/mcp.json',
};
