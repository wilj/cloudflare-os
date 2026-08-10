import { describe, expect, it } from 'vitest';
import { deriveAccountKey } from '../src/auth/login-flow';

const ISSUER = 'https://forge.example.com';

describe('deriveAccountKey', () => {
  it('produces a colon-free key', async () => {
    // Load-bearing, not cosmetic. Session tokens are "<doName>:<secret>" and
    // PublicApi.authenticate() splits on ":" and requires exactly two parts, so a key containing a
    // colon silently breaks authentication for every account it names. Issuers are URLs, so the
    // raw "issuer\0subject" pair could never be used directly.
    for (const subject of ['1', '4242', 'a:b', 'user@host']) {
      const key = await deriveAccountKey({ issuer: ISSUER, subject, email: null });
      expect(key).not.toContain(':');
      expect(key).toMatch(/^fj-[A-Za-z0-9_-]+$/);
    }
  });

  it('is stable across calls', async () => {
    const a = await deriveAccountKey({ issuer: ISSUER, subject: '1', email: 'a@example.com' });
    const b = await deriveAccountKey({ issuer: ISSUER, subject: '1', email: 'a@example.com' });
    expect(a).toBe(b);
  });

  it('ignores the email entirely', async () => {
    // The point of the whole design: a Forgejo user can change their own address, and doing so
    // must not create a second account and abandon the first one's workspaces.
    const before = await deriveAccountKey({ issuer: ISSUER, subject: '1', email: 'old@x.com' });
    const after = await deriveAccountKey({ issuer: ISSUER, subject: '1', email: 'new@y.com' });
    const none = await deriveAccountKey({ issuer: ISSUER, subject: '1', email: null });
    expect(after).toBe(before);
    expect(none).toBe(before);
  });

  it('separates different subjects and different issuers', async () => {
    const one = await deriveAccountKey({ issuer: ISSUER, subject: '1', email: null });
    const two = await deriveAccountKey({ issuer: ISSUER, subject: '2', email: null });
    const other = await deriveAccountKey({
      issuer: 'https://other.example.com', subject: '1', email: null,
    });
    expect(new Set([one, two, other]).size).toBe(3);
  });

  it('cannot be collided by re-partitioning issuer and subject', async () => {
    // The NUL separator is what makes the pair unambiguous: concatenating without one would let
    // ("https://a.com/x", "1") and ("https://a.com/", "x1") hash identically, letting one issuer
    // mint keys belonging to another.
    const a = await deriveAccountKey({ issuer: 'https://a.com/x', subject: '1', email: null });
    const b = await deriveAccountKey({ issuer: 'https://a.com/', subject: 'x1', email: null });
    expect(a).not.toBe(b);
  });

  it('produces a key short enough to be a Durable Object name', async () => {
    // idFromName() takes any string, but a 32-byte digest keeps it well inside sane bounds.
    const key = await deriveAccountKey({ issuer: ISSUER, subject: '1', email: null });
    expect(key.length).toBeLessThanOrEqual(64);
  });
});
