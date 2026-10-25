import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {pool} from '../database.js';
import {sendEmail} from '../email.js';
import {DomainError} from './errors.js';

type Access = 'READ' | 'WRITE';
type Invitation = Record<string, any>;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new DomainError(400, 'INVALID_EMAIL', 'A valid email address is required');
  }
  return normalized;
}

function publicInvitation(row: Invitation): Invitation {
  return {id: row.id, branchId: row.branch_id, email: row.email, access: row.access,
    state: row.state, emailStatus: row.email_status, expiresAt: row.expires_at,
    emailAttempts: row.email_attempts};
}

async function ownerBranch(client: PoolClient, branchId: string, ownerId: string): Promise<Invitation> {
  const found = await client.query(
    `SELECT b.id,d.id AS project_id,d.title,d.owner_id FROM business.branches b
     JOIN business.documents d ON d.id=b.document_id WHERE b.id=$1 FOR UPDATE OF b`, [branchId]);
  const branch = found.rows[0];
  if (!branch) throw new DomainError(404, 'NOT_FOUND', 'Branch not found');
  if (branch.owner_id !== ownerId) throw new DomainError(403, 'FORBIDDEN', 'Project owner access is required');
  return branch;
}

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export class InvitationService {
  constructor(private readonly publicBaseUrl: string, private readonly lifetimeDays: number) {
    if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 30) {
      throw new Error('INVITATION_LIFETIME_DAYS must be between 1 and 30');
    }
  }

  private async deliver(row: Invitation, token: string): Promise<Invitation> {
    const link = new URL('/app', this.publicBaseUrl);
    link.hash = `invite=${encodeURIComponent(token)}`;
    try {
      await sendEmail({
        to: row.email,
        subject: 'Invitation à collaborer',
        text: `Vous êtes invité à collaborer sur une branche du projet « ${row.title} ».
Ouvrez ce lien, vérifiez votre adresse e-mail, puis acceptez l'invitation :
${link.toString()}
Ce lien expire le ${new Date(row.expires_at).toISOString()}.`,
      });
      await pool.query(
        `UPDATE business.invitations SET email_status='SENT',email_attempts=email_attempts+1,
         last_email_error=NULL WHERE id=$1 AND token_hash=$2`, [row.id, digest(token)]);
      return {...publicInvitation(row), emailStatus: 'SENT', emailAttempts: row.email_attempts + 1};
    } catch (error) {
      await pool.query(
        `UPDATE business.invitations SET email_status='FAILED',email_attempts=email_attempts+1,
         last_email_error=$3 WHERE id=$1 AND token_hash=$2`,
        [row.id, digest(token), String(error).slice(0, 300)]);
      return {...publicInvitation(row), emailStatus: 'FAILED', emailAttempts: row.email_attempts + 1};
    }
  }

  async create(branchId: string, ownerId: string, emailInput: string, access: Access, key: string): Promise<Invitation> {
    const email = normalizeEmail(emailInput);
    const token = randomBytes(32).toString('hex');
    const result = await transaction(async (client) => {
      const branch = await ownerBranch(client, branchId, ownerId);
      const existing = await client.query(
        'SELECT * FROM business.invitations WHERE branch_id=$1 AND request_key=$2', [branchId, key]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.email !== email || row.access !== access) {
          throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'The key belongs to another invitation');
        }
        return {row, token: null};
      }
      await client.query(
        `UPDATE business.invitations SET state='EXPIRED'
         WHERE branch_id=$1 AND email=$2 AND state='PENDING' AND expires_at<=clock_timestamp()`,
        [branchId, email]);
      const pending = await client.query(
        `SELECT id FROM business.invitations WHERE branch_id=$1 AND email=$2 AND state='PENDING'`,
        [branchId, email]);
      if (pending.rowCount) throw new DomainError(409, 'PENDING_INVITATION_EXISTS', 'Resend the existing invitation');
      const permission = await client.query(
        `SELECT 1 FROM business.permissions p JOIN business.users u ON u.id=p.user_id
         WHERE p.branch_id=$1 AND u.email=$2`, [branchId, email]);
      if (permission.rowCount || email === (await client.query(
        'SELECT email FROM business.users WHERE id=$1', [ownerId])).rows[0]?.email) {
        throw new DomainError(409, 'ACCESS_ALREADY_GRANTED', 'Use permission management for existing access');
      }
      const inserted = await client.query(
        `INSERT INTO business.invitations(id,branch_id,email,access,token_hash,state,email_status,
          created_by,expires_at,request_key)
         VALUES($1,$2,$3,$4,$5,'PENDING','QUEUED',$6,clock_timestamp()+$7::interval,$8)
         RETURNING *`,
        [randomUUID(), branchId, email, access, digest(token), ownerId,
          `${this.lifetimeDays} days`, key]);
      return {row: {...inserted.rows[0], title: branch.title}, token};
    });
    if (!result.token) return publicInvitation(result.row);
    return this.deliver(result.row, result.token);
  }

  async list(branchId: string, ownerId: string): Promise<Invitation[]> {
    await transaction((client) => ownerBranch(client, branchId, ownerId));
    await pool.query(
      `UPDATE business.invitations SET state='EXPIRED'
       WHERE branch_id=$1 AND state='PENDING' AND expires_at<=clock_timestamp()`, [branchId]);
    const rows = await pool.query(
      'SELECT * FROM business.invitations WHERE branch_id=$1 ORDER BY created_at DESC', [branchId]);
    return rows.rows.map(publicInvitation);
  }

  async resend(invitationId: string, ownerId: string, access?: Access): Promise<Invitation> {
    const token = randomBytes(32).toString('hex');
    const row = await transaction(async (client) => {
      const found = await client.query(
        `SELECT i.*,d.title FROM business.invitations i
         JOIN business.branches b ON b.id=i.branch_id
         JOIN business.documents d ON d.id=b.document_id WHERE i.id=$1 FOR UPDATE OF i`, [invitationId]);
      const invitation = found.rows[0];
      if (!invitation) throw new DomainError(404, 'NOT_FOUND', 'Invitation not found');
      await ownerBranch(client, invitation.branch_id, ownerId);
      if (invitation.state === 'ACCEPTED') {
        throw new DomainError(409, 'INVITATION_ALREADY_ACCEPTED', 'Use permission management');
      }
      if (invitation.state === 'REVOKED') throw new DomainError(409, 'INVITATION_REVOKED', 'Create a new invitation');
      const updated = await client.query(
        `UPDATE business.invitations SET token_hash=$2,access=$3,state='PENDING',
         email_status='QUEUED',expires_at=clock_timestamp()+$4::interval,last_email_error=NULL
         WHERE id=$1 RETURNING *`,
        [invitationId, digest(token), access ?? invitation.access, `${this.lifetimeDays} days`]);
      return {...updated.rows[0], title: invitation.title};
    });
    return this.deliver(row, token);
  }

  async revoke(invitationId: string, ownerId: string): Promise<void> {
    await transaction(async (client) => {
      const found = await client.query('SELECT * FROM business.invitations WHERE id=$1 FOR UPDATE', [invitationId]);
      const row = found.rows[0];
      if (!row) throw new DomainError(404, 'NOT_FOUND', 'Invitation not found');
      await ownerBranch(client, row.branch_id, ownerId);
      if (row.state !== 'PENDING') throw new DomainError(409, 'INVITATION_NOT_PENDING', 'Invitation is not pending');
      await client.query("UPDATE business.invitations SET state='REVOKED' WHERE id=$1", [invitationId]);
    });
  }

  async preview(token: string): Promise<Invitation> {
    const row = (await pool.query(
      `SELECT i.*,d.title FROM business.invitations i JOIN business.branches b ON b.id=i.branch_id
       JOIN business.documents d ON d.id=b.document_id WHERE i.token_hash=$1`, [digest(token)])).rows[0];
    if (!row) throw new DomainError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
    if (row.state === 'PENDING' && new Date(row.expires_at) <= new Date()) {
      await pool.query("UPDATE business.invitations SET state='EXPIRED' WHERE id=$1 AND state='PENDING'", [row.id]);
      row.state = 'EXPIRED';
    }
    return {projectTitle: row.title, email: row.email, access: row.access,
      state: row.state, expiresAt: row.expires_at};
  }

  async accept(token: string, userId: string, verifiedEmail: string): Promise<Invitation> {
    await pool.query(
      `UPDATE business.invitations SET state='EXPIRED'
       WHERE token_hash=$1 AND state='PENDING' AND expires_at<=clock_timestamp()`,
      [digest(token)]);
    return transaction(async (client) => {
      const found = await client.query(
        'SELECT * FROM business.invitations WHERE token_hash=$1 FOR UPDATE', [digest(token)]);
      const row = found.rows[0];
      if (!row) throw new DomainError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
      if (row.state === 'EXPIRED') throw new DomainError(410, 'INVITATION_EXPIRED', 'Invitation has expired');
      if (row.state !== 'PENDING') throw new DomainError(409, 'INVITATION_NOT_PENDING', 'Invitation is not pending');
      if (new Date(row.expires_at) <= new Date()) {
        await client.query("UPDATE business.invitations SET state='EXPIRED' WHERE id=$1", [row.id]);
        throw new DomainError(410, 'INVITATION_EXPIRED', 'Invitation has expired');
      }
      if (row.email !== verifiedEmail) {
        throw new DomainError(403, 'EMAIL_MISMATCH', 'The verified email does not match the invitation');
      }
      await client.query(
        `INSERT INTO business.permissions(branch_id,user_id,access) VALUES($1,$2,$3)
         ON CONFLICT(branch_id,user_id) DO UPDATE SET access=EXCLUDED.access`,
        [row.branch_id, userId, row.access]);
      const updated = await client.query(
        `UPDATE business.invitations SET state='ACCEPTED',accepted_by=$2,accepted_at=clock_timestamp()
         WHERE id=$1 RETURNING *`, [row.id, userId]);
      return publicInvitation(updated.rows[0]);
    });
  }

  async collaborators(branchId: string, ownerId: string): Promise<Invitation[]> {
    await transaction((client) => ownerBranch(client, branchId, ownerId));
    return (await pool.query(
      `SELECT p.user_id AS "userId",u.name,u.email,p.access FROM business.permissions p
       JOIN business.users u ON u.id=p.user_id WHERE p.branch_id=$1 ORDER BY u.email`,
      [branchId])).rows;
  }

  async updateCollaborator(branchId: string, ownerId: string, userId: string,
                           access: Access | null): Promise<void> {
    await transaction(async (client) => {
      const branch = await ownerBranch(client, branchId, ownerId);
      if (branch.owner_id === userId) {
        throw new DomainError(400, 'OWNER_PERMISSION', 'Project owner access cannot be changed');
      }
      const existing = await client.query(
        'SELECT 1 FROM business.permissions WHERE branch_id=$1 AND user_id=$2 FOR UPDATE',
        [branchId, userId]);
      if (!existing.rowCount) throw new DomainError(404, 'COLLABORATOR_NOT_FOUND', 'Collaborator not found');
      if (access) await client.query(
        'UPDATE business.permissions SET access=$3 WHERE branch_id=$1 AND user_id=$2',
        [branchId, userId, access]);
      else await client.query(
        'DELETE FROM business.permissions WHERE branch_id=$1 AND user_id=$2',
        [branchId, userId]);
    });
  }
}
