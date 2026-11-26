import { describe, expect, it } from 'vitest';
import { GUIDE_STEPS } from './guideSteps';

describe('how-to-use guide', () => {
  it('has every step in English and Malayalam', () => {
    for (const s of GUIDE_STEPS) {
      expect(s.title.en.length).toBeGreaterThan(1);
      expect(s.body.en.length).toBeGreaterThan(10);
      expect(s.body.ml).toMatch(/[ഀ-ൿ]/);   // Malayalam script
    }
  });
  it('points at the menu items the sidebar marks with data-guide', () => {
    const targets = GUIDE_STEPS.map((s) => s.target).filter(Boolean);
    expect(targets).toEqual(['nav-home', 'nav-floor', 'nav-ai', 'nav-bookings', 'nav-bills', 'nav-customers', 'group-more', 'group-setup', 'guide']);
  });
});
