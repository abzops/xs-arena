import { describe, expect, it } from 'vitest';
import { keyBytes } from './b64';

describe('keyBytes', () => {
  it('decodes base64url without padding', () => {
    expect(Array.from(keyBytes('AQID_-8'))).toEqual([1, 2, 3, 255, 239]);
  });
  it('decodes a 65-byte VAPID public key', () => {
    const k = 'B' + 'A'.repeat(86);
    expect(keyBytes(k).length).toBe(65);
  });
});
