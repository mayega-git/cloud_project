export type Access = 'READ' | 'WRITE';

export interface Project {projectId: string; title: string; ownerTimeZone: string; isOwner: boolean}
export interface Branch {id: string; number: number; activeVersionId: string | null}
export interface Version {
  id: string; number: number; padId: string; state: 'OPEN' | 'CLOSING' | 'FROZEN'; finalRevision: number | null;
}
export interface Invitation {id: string; email: string; access: Access; state: string; emailStatus: string}
export interface Collaborator {userId: string; name: string; email: string; access: Access}
export interface DownloadLink {id: string; maxDownloads: number; remaining: number; createdAt: string}
export interface InvitationPreview {projectTitle: string; email: string; access: Access; state: string}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// crypto.randomUUID() only exists in secure contexts (HTTPS or localhost), so
// a plain-HTTP deployment would break on it. getRandomValues works everywhere.
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Options extends Omit<RequestInit, 'body'> {
  json?: unknown;
  idempotent?: boolean;
}

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const {json, idempotent, headers: extraHeaders, ...rest} = options;
  const headers = new Headers(extraHeaders);
  if (json !== undefined) headers.set('content-type', 'application/json');
  if (idempotent) headers.set('Idempotency-Key', newIdempotencyKey());
  const response = await fetch(`/backend${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers,
    ...(json !== undefined ? {body: JSON.stringify(json)} : {}),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(data?.error?.message ?? data?.message ?? `HTTP error ${response.status}`, response.status);
  }
  return data as T;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}
