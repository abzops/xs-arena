import { describe, expect, it } from 'vitest';
import { DEMO_MAILTO, parseFlag, primaryCta, SIGNUP_OPEN } from './flags';

describe('parseFlag', () => {
  it('is false when unset or empty', () => {
    expect(parseFlag(undefined)).toBe(false);
    expect(parseFlag(null)).toBe(false);
    expect(parseFlag('')).toBe(false);
  });
  it('accepts true / 1 / yes in any case', () => {
    for (const v of ['true', 'TRUE', ' True ', '1', 'yes', 'YES']) expect(parseFlag(v)).toBe(true);
  });
  it('treats anything else as false', () => {
    for (const v of ['false', '0', 'no', 'open', 'truee']) expect(parseFlag(v)).toBe(false);
  });
});

describe('primaryCta', () => {
  it('offers a demo by email while sign-up is closed', () => {
    expect(primaryCta(false)).toEqual({ label: 'Get a demo', href: 'mailto:support@xelorsoft.com?subject=XS%20Arena%20demo', external: true });
    expect(primaryCta(false, true).label).toBe('Get a demo');
  });
  it('offers the trial when sign-up is open', () => {
    expect(primaryCta(true)).toEqual({ label: 'Start free trial', href: '/login?mode=signup', external: false });
    expect(primaryCta(true, true).label).toBe('Start 14-day free trial');
  });
  it('mail subject is "XS Arena demo"', () => {
    expect(decodeURIComponent(new URL(DEMO_MAILTO).searchParams.get('subject') ?? '')).toBe('XS Arena demo');
  });
});

describe('default build', () => {
  it('keeps sign-up closed unless SIGNUP_OPEN is set', () => {
    expect(SIGNUP_OPEN).toBe(parseFlag(process.env.SIGNUP_OPEN));
  });
});
