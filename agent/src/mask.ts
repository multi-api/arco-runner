import type { Redactor } from '@multiapi/arco-cloud-client';
import type { JobDocument } from './job/document.js';

const MIN_MASK_LENGTH = 4;

/** Decodes `basic base64(x-access-token:<token>)`; null when the header has another shape. */
export function cloneToken(authHeader: string): string | null {
  const m = /^basic\s+(\S+)$/i.exec(authHeader.trim());
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const prefix = 'x-access-token:';
  if (!decoded.startsWith(prefix)) return null;
  return decoded.slice(prefix.length) || null;
}

const signature = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('X-Amz-Signature');
  } catch {
    return null;
  }
};

export function registerJobSecrets(r: Redactor, d: JobDocument): void {
  const secrets: Array<string | null> = [
    ...d.mask,
    d.runner_token,
    d.nonce,
    d.source.auth_header,
    cloneToken(d.source.auth_header),
    d.cache.restore_url,
    d.cache.save_url,
    signature(d.cache.restore_url),
    signature(d.cache.save_url),
  ];
  for (const s of secrets) if (s) r.add(s);
}

export function shortMaskValues(d: JobDocument): number {
  return d.mask.filter((v) => v.length < MIN_MASK_LENGTH).length;
}
