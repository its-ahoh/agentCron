// Time maths: durations ("30m"), clock times ("09:00"), and 5-field cron in local time.

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function parseDuration(text) {
  const s = String(text).trim().toLowerCase();
  if (!/^(\d+(\.\d+)?[smhdw])+$/.test(s)) {
    throw new Error(`bad duration "${text}" (use e.g. 90s, 30m, 2h, 1d, 1h30m)`);
  }
  let ms = 0;
  for (const [, n, unit] of s.matchAll(/(\d+(?:\.\d+)?)([smhdw])/g)) ms += Number(n) * UNITS[unit];
  return Math.round(ms);
}

export function formatDuration(ms) {
  for (const [unit, size] of [['d', UNITS.d], ['h', UNITS.h], ['m', UNITS.m]]) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

// "HH:MM" means the next time the clock shows that; anything else is parsed as a date.
export function parseAt(text, now = Date.now()) {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (clock) {
    const [h, m] = [Number(clock[1]), Number(clock[2])];
    if (h > 23 || m > 59) throw new Error(`bad time "${text}"`);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = new Date(text).getTime();
  if (Number.isNaN(t)) throw new Error(`bad time "${text}" (use HH:MM or 2026-11-23T09:00)`);
  return t;
}

const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(text, lo, hi) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad cron field "${text}"`);
    let [a, b] = m[1] === '*' ? [lo, hi] : m[1].split('-').map(Number);
    if (b === undefined) b = m[2] ? hi : a;
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`bad cron field "${text}"`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`bad cron "${expr}" (need 5 fields: min hour day month weekday)`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, ...CRON_RANGES[i]));
  if (dow.delete(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk; // classic cron: both restricted means either
}

// First matching minute strictly after `after`.
export function nextCron(expr, after = Date.now()) {
  const c = parseCron(expr);
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let days = 0; days < 366 * 5; days++) {
    if (!c.month.has(d.getMonth() + 1) || !dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const day = d.getDate();
    while (d.getDate() === day) {
      if (c.hour.has(d.getHours()) && c.minute.has(d.getMinutes())) return d.getTime();
      d.setMinutes(d.getMinutes() + 1);
    }
  }
  throw new Error(`cron "${expr}" never fires`);
}

// Next due time of a recurring timer after `now`. Missed occurrences are skipped, not replayed.
export function nextOccurrence(timer, now = Date.now()) {
  if (timer.kind === 'cron') return nextCron(timer.spec, now);
  if (timer.kind === 'every') {
    const step = Number(timer.spec);
    const base = timer.next_due_at ?? now;
    if (base > now) return base;
    return base + (Math.floor((now - base) / step) + 1) * step;
  }
  return null;
}

export function describeSchedule(timer) {
  if (timer.kind === 'every') return `every ${formatDuration(Number(timer.spec))}`;
  if (timer.kind === 'cron') return `cron ${timer.spec}`;
  return timer.check_cmd ? 'once (when check passes)' : 'once';
}

export function formatTime(ms) {
  if (ms == null) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
