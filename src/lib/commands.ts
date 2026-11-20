// Floor commands that survive a dropped connection.
// Every command carries the device time (p_client_at) and the app's own ids, so the server can
// replay it safely. If the network is down, the command waits in localStorage and is sent again
// when the connection returns. The server decides the time (it only trusts plausible device time).
import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';

type Queued = { id: string; fn: string; args: Record<string, unknown>; at: string };
const KEY = 'xs-arena-queue';
const listeners = new Set<() => void>();

function read(): Queued[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Queued[]; } catch { return []; }
}
function write(q: Queued[]) {
  try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage blocked */ }
  snapshot = q.length;
  listeners.forEach((l) => l());
}
let snapshot = read().length;

function isNetworkError(e: unknown) {
  const m = (e as { message?: string })?.message ?? '';
  return !navigator.onLine || /Failed to fetch|NetworkError|Load failed|network/i.test(m);
}

let flushing = false;
export async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    let q = read();
    while (q.length) {
      const item = q[0];
      const { error } = await supabase.rpc(item.fn, item.args);
      if (error && isNetworkError(error)) break;
      // A business error on replay (e.g. table already ended) is dropped: the server state wins.
      q = read().filter((x) => x.id !== item.id);
      write(q);
    }
  } finally {
    flushing = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flushQueue());
  setInterval(() => { if (read().length) void flushQueue(); }, 15000);
}

/** Run a floor command now; if offline, keep it and send later. Returns null when queued. */
export async function command<T>(fn: string, args: Record<string, unknown>): Promise<T | null> {
  const withTime = { ...args, p_client_at: new Date().toISOString() };
  try {
    const { data, error } = await supabase.rpc(fn, withTime);
    if (error) throw error;
    return data as T;
  } catch (e) {
    if (isNetworkError(e)) {
      write([...read(), { id: crypto.randomUUID(), fn, args: withTime, at: withTime.p_client_at }]);
      return null;
    }
    throw e;
  }
}

export function usePendingCommands() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => snapshot);
}
