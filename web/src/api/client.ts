import { hc } from 'hono/client';
import type { AppType } from '@api/index';

function normalizeApiBaseUrl(raw: string | undefined): string {
  let value = (raw ?? '').trim();
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\/+$/, '');
  value = value.replace(/\/api$/, '');
  return value;
}

const apiUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_URL);

export const client = hc<AppType>(apiUrl);
