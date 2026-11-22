import { describe, expect, it } from 'vitest';
import { RateLimitResult, TokenBucket } from './rateLimit';

const { Allowed, Limited, Exceeded } = RateLimitResult;

function takeAll(bucket: TokenBucket, times: ReadonlyArray<number>) {
  return times.map((time) => bucket.take(time));
}

describe('TokenBucket', () => {
  it.each([
    { name: 'a burst up to the limit', limit: 3, times: [0, 0, 0], expected: [Allowed, Allowed, Allowed] },
    { name: 'a burst over the limit', limit: 2, times: [0, 0, 0], expected: [Allowed, Allowed, Limited] },
    {
      name: 'a burst up to 3x the limit',
      limit: 2,
      times: [0, 0, 0, 0, 0, 0],
      expected: [Allowed, Allowed, Limited, Limited, Limited, Limited],
    },
    {
      name: 'a burst over 3x the limit',
      limit: 2,
      times: [0, 0, 0, 0, 0, 0, 0],
      expected: [Allowed, Allowed, Limited, Limited, Limited, Limited, Exceeded],
    },
    {
      name: 'a refill after one second',
      limit: 2,
      times: [0, 0, 1000, 1000],
      expected: [Allowed, Allowed, Allowed, Allowed],
    },
    {
      name: 'limited messages counting against the next refill',
      limit: 2,
      times: [0, 0, 0, 1000, 1000],
      expected: [Allowed, Allowed, Limited, Allowed, Limited],
    },
    { name: 'a partial refill', limit: 2, times: [0, 0, 500, 500], expected: [Allowed, Allowed, Allowed, Limited] },
    {
      name: 'a refill capped at the limit',
      limit: 2,
      times: [0, 10_000, 10_000, 10_000],
      expected: [Allowed, Allowed, Allowed, Limited],
    },
    {
      name: 'a steady rate at the limit',
      limit: 10,
      times: Array.from({ length: 30 }, (_, i) => i * 100),
      expected: Array(30).fill(Allowed),
    },
    { name: 'a clock going backwards', limit: 1, times: [1000, 0], expected: [Allowed, Limited] },
  ])('handles $name', ({ limit, times, expected }) => {
    expect(takeAll(new TokenBucket(limit, 0), times)).toEqual(expected);
  });
});
