const ORIGIN_ENTRY_PATTERN = /^https?:\/\/[a-z0-9.*-]+(:\d+)?$/;

export function parseAllowedOrigins(value: string): ReadonlyArray<string> {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

export function isValidOriginEntry(entry: string): boolean {
  return ORIGIN_ENTRY_PATTERN.test(entry);
}

export function createOriginMatcher(entries: ReadonlyArray<string>): (origin: string) => boolean {
  const patterns = entries.map((entry) => new RegExp(`^${entry.split('*').map(escapeRegExp).join('[a-z0-9-]+')}$`));
  return (origin) => {
    const normalized = origin.toLowerCase();
    return patterns.some((pattern) => pattern.test(normalized));
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
