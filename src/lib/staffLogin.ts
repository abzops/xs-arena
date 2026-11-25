// Staff logins made by the owner: a username + password instead of an email (same as XS Gym).
// Behind the scenes the username maps to an internal address that is never mailed.
import { ROLE_LABEL, type Role } from './types';

export const STAFF_LOGIN_DOMAIN = 'staff.xelorsoft.com';

/** What the sign-in form sends to Supabase: an email as typed, or a username mapped to its login address. */
export function loginEmail(input: string): string {
  const v = input.trim();
  return v.includes('@') ? v : `${v.toLowerCase()}@${STAFF_LOGIN_DOMAIN}`;
}

export const isUsername = (input: string) => !!input.trim() && !input.includes('@');

export type Credentials = { username: string; password: string; name: string; phone: string | null; role: Role };
export type CredentialLang = 'en' | 'ml';

export function loginUrl(username: string, origin = window.location.origin): string {
  const url = new URL('/login', origin);
  url.searchParams.set('u', username);
  return url.toString();
}

/** The WhatsApp message with the login details, in English or Malayalam. */
export function credentialsText(lang: CredentialLang, c: Credentials, centre: string, url: string, reset = false): string {
  const first = c.name.split(' ')[0];
  const role = ROLE_LABEL[c.role];
  if (lang === 'ml') {
    const head = reset
      ? `ഹായ് ${first}, ${centre}-ന്റെ XS Arena ലോഗിൻ പാസ്‌വേഡ് മാറ്റി. പുതിയ വിവരങ്ങൾ:`
      : `ഹായ് ${first}, ${centre}-ന്റെ XS Arena-യിൽ നിങ്ങളെ ${role} ആയി ചേർത്തു. ലോഗിൻ വിവരങ്ങൾ:`;
    return `${head}\n\nസൈൻ ഇൻ: ${url}\nUsername: ${c.username}\nPassword: ${c.password}\n\nഈ പാസ്‌വേഡ് ആരുമായും പങ്കിടരുത്.`;
  }
  const head = reset
    ? `Hi ${first}, your XS Arena password for ${centre} has been reset. Your new login:`
    : `Hi ${first}, you've been added to ${centre} on XS Arena as ${role}. Your login:`;
  return `${head}\n\nSign in: ${url}\nUsername: ${c.username}\nPassword: ${c.password}\n\nPlease don't share this password.`;
}
