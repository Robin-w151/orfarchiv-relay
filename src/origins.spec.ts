import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_ORIGINS } from './config';
import { createOriginMatcher, isValidOriginEntry, parseAllowedOrigins } from './origins';

describe('parseAllowedOrigins', () => {
  it.each([
    { value: '', expected: [] },
    { value: ' , ', expected: [] },
    { value: 'http://localhost:3001', expected: ['http://localhost:3001'] },
    { value: ' https://A.example , https://b.example,', expected: ['https://a.example', 'https://b.example'] },
  ])("parses '$value'", ({ value, expected }) => {
    expect(parseAllowedOrigins(value)).toEqual(expected);
  });
});

describe('isValidOriginEntry', () => {
  it.each([
    { entry: 'https://orfarchiv.news', valid: true },
    { entry: 'http://localhost:3001', valid: true },
    { entry: 'https://orfarchiv-*-robins-projects-bb10f956.vercel.app', valid: true },
    { entry: 'https://orfarchiv.news/', valid: false },
    { entry: 'https://orfarchiv.news/path', valid: false },
    { entry: '*://orfarchiv.news', valid: false },
    { entry: 'https://orfarchiv.news:*', valid: false },
    { entry: 'orfarchiv.news', valid: false },
    { entry: '*', valid: false },
  ])('treats $entry as valid: $valid', ({ entry, valid }) => {
    expect(isValidOriginEntry(entry)).toBe(valid);
  });
});

describe('createOriginMatcher', () => {
  const isAllowed = createOriginMatcher(parseAllowedOrigins(DEFAULT_ALLOWED_ORIGINS));

  it.each([
    { origin: 'https://orfarchiv.news', allowed: true },
    { origin: 'https://develop.orfarchiv.news', allowed: true },
    { origin: 'https://ORFARCHIV.news', allowed: true },
    { origin: 'https://orfarchiv-git-feat-x-robins-projects-bb10f956.vercel.app', allowed: true },
    { origin: 'https://orfarchiv-a1b2c3-robins-projects-bb10f956.vercel.app', allowed: true },
    { origin: 'https://evil.vercel.app', allowed: false },
    { origin: 'https://orfarchiv-a.b-robins-projects-bb10f956.vercel.app', allowed: false },
    { origin: 'https://orfarchiv--robins-projects-bb10f956.vercel.app', allowed: false },
    { origin: 'https://orfarchiv-x-robins-projects-bb10f956.vercel.app.evil.com', allowed: false },
    { origin: 'https://orfarchiv-x_y-robins-projects-bb10f956.vercel.app', allowed: false },
    { origin: 'https://orfarchivxnews', allowed: false },
    { origin: 'http://orfarchiv.news', allowed: false },
    { origin: 'https://orfarchiv.news:8443', allowed: false },
    { origin: 'null', allowed: false },
  ])('allows $origin: $allowed', ({ origin, allowed }) => {
    expect(isAllowed(origin)).toBe(allowed);
  });

  it('allows nothing for an empty list', () => {
    expect(createOriginMatcher([])('https://orfarchiv.news')).toBe(false);
  });
});
