import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import {pool} from '../database.js';
import {DomainError} from './errors.js';

const cookieName = 'business_session';

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function cookieToken(cookieHeader: string | undefined): string | null {
  const match = cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  return match?.slice(cookieName.length + 1) || null;
}

export async function sessionUser(token: string | null): Promise<string | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const result = await pool.query<{user_id: string}>(
    'SELECT user_id FROM business.sessions WHERE token_hash = $1 AND expires_at > now()', [tokenHash(token)]);
  return result.rows[0]?.user_id ?? null;
}

export async function requireUser(request: FastifyRequest): Promise<string> {
  const userId = await sessionUser(cookieToken(request.headers.cookie));
  if (!userId) throw new DomainError(401, 'UNAUTHENTICATED', 'A valid session is required');
  return userId;
}

export async function requireVerifiedUser(request: FastifyRequest): Promise<{id: string; email: string}> {
  const token = cookieToken(request.headers.cookie);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    throw new DomainError(401, 'VERIFIED_SESSION_REQUIRED', 'A verified session is required');
  }
  const result = await pool.query<{id: string; email: string}>(
    `SELECT u.id,u.email FROM business.sessions s JOIN business.users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND s.verified_at IS NOT NULL`,
    [tokenHash(token)]);
  if (!result.rows[0]) throw new DomainError(401, 'VERIFIED_SESSION_REQUIRED', 'A verified session is required');
  return result.rows[0];
}

export async function createVerifiedSession(name: string, email: string): Promise<{userId: string; token: string}> {
  const normalized = email.trim().toLowerCase();
  const user = await pool.query<{id: string}>(
    `INSERT INTO business.users(id,name,email) VALUES($1,$2,$3)
     ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    [randomUUID(), name.trim(), normalized]);
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO business.sessions(token_hash,user_id,expires_at,verified_at)
     VALUES($1,$2,clock_timestamp()+interval '12 hours',clock_timestamp())`,
    [tokenHash(token), user.rows[0]!.id]);
  return {userId: user.rows[0]!.id, token};
}

export async function createLocalSession(name: string, email: string): Promise<{userId: string; token: string}> {
  const normalized = email.trim().toLowerCase();
  const userId = randomUUID();
  const user = await pool.query<{id: string}>(
    `INSERT INTO business.users(id, name, email) VALUES ($1,$2,$3)
     ON CONFLICT(email) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [userId, name.trim(), normalized]);
  const token = randomBytes(32).toString('hex');
  await pool.query(
    "INSERT INTO business.sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '12 hours')",
    [tokenHash(token), user.rows[0]!.id]);
  return {userId: user.rows[0]!.id, token};
}

export function sessionCookie(token: string): string {
  return `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`;
}

export function internalKeyMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
