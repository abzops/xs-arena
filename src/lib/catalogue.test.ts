import { describe, expect, it } from 'vitest';
import { CATALOGUE, layoutItems } from './catalogue';

const item = (k: string) => CATALOGUE.find((c) => c.key === k)!;
const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('Ready-made arena items', () => {
  it('has unique keys and names', () => {
    expect(new Set(CATALOGUE.map((c) => c.key)).size).toBe(CATALOGUE.length);
    expect(new Set(CATALOGUE.map((c) => c.name.toLowerCase())).size).toBe(CATALOGUE.length);
    for (const c of CATALOGUE) expect(c.name.length).toBeLessThanOrEqual(40);
  });
  it('lays out a typical arena with nothing overlapping, inside the hall', () => {
    const picks = [['snooker', 4], ['pool', 2], ['ps5', 6], ['vr', 2], ['rc-drift', 1], ['rc-offroad', 1], ['turf', 1]] as const;
    const lay = layoutItems(picks.map(([k, n]) => ({ item: item(k), count: n, activityId: k })), { width: 2000, height: 1200 });
    expect(lay.resources).toHaveLength(17);
    for (const r of lay.resources) {
      expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(lay.width); expect(r.y + r.h).toBeLessThanOrEqual(lay.height);
    }
    for (let i = 0; i < lay.resources.length; i++) for (let j = i + 1; j < lay.resources.length; j++)
      expect(overlap(lay.resources[i], lay.resources[j]), `${lay.resources[i].name} / ${lay.resources[j].name}`).toBe(false);
    const names = lay.resources.map((r) => r.name);
    expect(names).toContain('Snooker 4'); expect(names).toContain('PS5 #6'); expect(names).toContain('RC Drift track'); expect(names).toContain('VR #2');
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });
  it('numbers tracks only when there are several', () => {
    const lay = layoutItems([{ item: item('rc-drift'), count: 2, activityId: 'd' }], { width: 2000, height: 1200 });
    expect(lay.resources.map((r) => r.name)).toEqual(['RC Drift track 1', 'RC Drift track 2']);
  });
});
