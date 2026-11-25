import { describe, expect, it } from 'vitest';
import { credentialsText, isUsername, loginEmail, loginUrl } from './staffLogin';

describe('staff logins', () => {
  it('maps a username to its internal login address and leaves emails alone', () => {
    expect(loginEmail(' Ravi.XS ')).toBe('ravi.xs@staff.xelorsoft.com');
    expect(loginEmail('owner@gmail.com ')).toBe('owner@gmail.com');
    expect(isUsername('ravi.xs')).toBe(true);
    expect(isUsername('owner@gmail.com')).toBe(false);
    expect(isUsername('  ')).toBe(false);
  });

  it('builds the sign-in link with the username filled in', () => {
    expect(loginUrl('ravi.xs', 'https://arena.xelorsoft.com')).toBe('https://arena.xelorsoft.com/login?u=ravi.xs');
  });

  it('writes the WhatsApp message in English and Malayalam', () => {
    const c = { username: 'ravi.xs', password: 'k7Qm-x3Fp', name: 'Ravi Kumar', phone: '9847011111', role: 'front_desk' as const };
    const en = credentialsText('en', c, 'Cue Club', 'https://x/login?u=ravi.xs');
    expect(en).toContain('Hi Ravi');
    expect(en).toContain('as Front desk');
    expect(en).toContain('Username: ravi.xs');
    expect(en).toContain('Password: k7Qm-x3Fp');
    const ml = credentialsText('ml', c, 'Cue Club', 'https://x/login?u=ravi.xs', true);
    expect(ml).toContain('പാസ്‌വേഡ് മാറ്റി');
    expect(ml).toContain('Password: k7Qm-x3Fp');
  });
});
