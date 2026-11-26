import { describe, expect, it } from 'vitest';
import { waNumber } from './wa';

describe('WhatsApp numbers', () => {
  it('adds 91 to a bare Indian mobile', () => {
    expect(waNumber('98470 12345')).toBe('919847012345');
    expect(waNumber('09847012345')).toBe('919847012345');
  });
  it('keeps numbers that already have a country code', () => {
    expect(waNumber('+91 98470 12345')).toBe('919847012345');
    expect(waNumber('+971 50 123 4567')).toBe('971501234567');
  });
});
