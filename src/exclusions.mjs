/**
 * Working out which traffic sources should not be counted as users.
 *
 * Every deployment has some: uptime monitors, a QA runner, CI, your own
 * crawlers. Left in, they quietly inflate request counts and unique-visitor
 * counts, and the inflation is worst exactly when you are trying to work out
 * whether something is wrong.
 *
 * Entries may be given as hostnames rather than addresses, because that is how
 * people know their own machines — "the QA box" is a name, and its address is
 * something you would otherwise have to go and look up. Hostnames are resolved
 * at setup time and stored as addresses, since addresses are what logs contain.
 *
 * The package ships no built-in list: one deployment's monitor is another's
 * real user. The suggestion below is derived from the instance being configured
 * rather than hardcoded.
 */
import { lookup } from 'node:dns/promises';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpAddress(value) {
  const v = String(value).trim();
  const m = IPV4.exec(v);
  if (m) return m.slice(1).every((o) => Number(o) <= 255);
  // Good enough to tell an address from a hostname; the DNS lookup is the real check.
  return /^[0-9a-f:]+$/i.test(v) && v.includes(':');
}

/** Split a comma/space/semicolon-separated answer into entries. */
export function splitEntries(input) {
  return String(input ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Turn a free-text answer into addresses. Hostnames are resolved; anything that
 * cannot be resolved is reported rather than silently dropped, because a typo
 * in an exclusion list is invisible later — the counts are simply wrong.
 */
export async function resolveEntries(input) {
  const resolved = [];
  const failed = [];
  for (const entry of splitEntries(input)) {
    if (isIpAddress(entry)) {
      resolved.push({ ip: entry, from: null });
      continue;
    }
    try {
      const addresses = await lookup(entry, { all: true });
      if (!addresses.length) throw new Error('no addresses');
      for (const a of addresses) resolved.push({ ip: a.address, from: entry });
    } catch (err) {
      failed.push({ entry, reason: err.code ?? err.message });
    }
  }
  // Keep the first mention of each address, so the labels stay meaningful.
  const seen = new Set();
  const unique = resolved.filter((r) => (seen.has(r.ip) ? false : seen.add(r.ip)));
  return { resolved: unique, failed };
}

/**
 * Suggest an exclusion derived from the instance itself.
 *
 * The machine running your observability stack is very often the machine
 * running your monitors and scheduled jobs too, so its address is a reasonable
 * thing to offer — but only as a suggestion the user confirms, since it is not
 * true everywhere.
 */
export async function suggestFromInstance(url) {
  try {
    const host = new URL(url).hostname;
    if (isIpAddress(host)) return [{ ip: host, from: host, why: 'your OpenObserve instance' }];
    const addresses = await lookup(host, { all: true });
    return addresses.map((a) => ({ ip: a.address, from: host, why: 'the host your OpenObserve instance runs on' }));
  } catch {
    return [];
  }
}

export function formatEntry(entry) {
  return entry.from && entry.from !== entry.ip ? `${entry.ip} (${entry.from})` : entry.ip;
}
