// Build-time switches. Set in the build environment (e.g. SIGNUP_OPEN=true npm run build).

/** "true" / "1" / "yes" (any case) → true; anything else, or unset → false. */
export function parseFlag(value: string | undefined | null): boolean {
  return /^(true|1|yes)$/i.test((value ?? '').trim());
}

/** Public sign-up. Off until the app is ready for strangers: new centres get a demo instead. */
export const SIGNUP_OPEN: boolean = typeof __SIGNUP_OPEN__ === 'boolean' ? __SIGNUP_OPEN__ : false;

export const DEMO_EMAIL = 'support@xelorsoft.com';
export const DEMO_MAILTO = `mailto:${DEMO_EMAIL}?subject=XS%20Arena%20demo`;

/** The main call to action on the landing page. */
export function primaryCta(open: boolean, long = false): { label: string; href: string; external: boolean } {
  return open
    ? { label: long ? 'Start 14-day free trial' : 'Start free trial', href: '/login?mode=signup', external: false }
    : { label: 'Get a demo', href: DEMO_MAILTO, external: true };
}
