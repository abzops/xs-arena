// Calls the staff-login Edge Function (make a login, reset a password).
import type { Credentials } from './staffLogin';
import { supabase } from './supabase';

async function call(body: Record<string, unknown>): Promise<Credentials> {
  const { data, error } = await supabase.functions.invoke('staff-login', { body });
  if (error) {
    let msg = 'Something went wrong. Please try again.';
    try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) msg = b.error; } catch { /* not JSON */ }
    if (/Failed to fetch|NetworkError|Load failed/i.test(error.message)) msg = 'No connection. Check the internet and try again.';
    throw new Error(msg);
  }
  return data as Credentials;
}

export const createStaffLogin = (centreId: string, staffId: string) => call({ action: 'create', centre_id: centreId, staff_id: staffId });
export const resetStaffPassword = (centreId: string, staffId: string) => call({ action: 'reset', centre_id: centreId, staff_id: staffId });
