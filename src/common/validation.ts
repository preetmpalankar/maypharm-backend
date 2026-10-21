import { z } from 'zod';

export const uuidSchema = z.uuid({ error: 'Invalid record id.' });

export function parseId(value: string) {
  return uuidSchema.parse(value);
}

/** PostgREST treats these characters as operators inside ilike/or filters. */
export function escapeFilter(value: string) {
  return value.replace(/[%_,()*\\]/g, '');
}

export function toSafeSlug(value: string, maxLength = 60) {
  return (
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, maxLength) || 'file'
  );
}
