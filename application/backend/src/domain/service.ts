import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {pool} from '../database.js';
import {EtherpadClient, EtherpadError} from '../etherpad.js';
import {nextLocalMidnight} from './calendar.js';
import {DomainError} from './errors.js';
import {tokenHash} from './auth.js';

type Row = Record<string, any>;

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
  } finally {
    client.release();
  }
}

function one(rows: Row[], code = 'NOT_FOUND'): Row {
  if (!rows[0]) throw new DomainError(404, code, 'Resource not found');
  return rows[0];
}

export class BusinessService {
  constructor(private readonly etherpad: EtherpadClient, private readonly internalKey: string,
              private readonly etherpadApiUrl: string) {}

  async createDocument(ownerId: string, title: string, timeZone: string, key: string): Promise<Row> {
    const document = await transaction(async (client) => {
      const existing = await client.query('SELECT * FROM business.documents WHERE owner_id=$1 AND creation_key=$2', [ownerId, key]);
      if (existing.rows[0]) {
        if (existing.rows[0].title !== title || existing.rows[0].owner_timezone !== timeZone) {
          throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'The key belongs to another request');
        }
        return existing.rows[0];
      }
      const id = randomUUID();
      const padId = `business-${id}`;
      const created = one((await client.query(
        `INSERT INTO business.documents(id,owner_id,owner_timezone,title,status,initial_pad_id,creation_key)
         VALUES($1,$2,$3,$4,'PROVISIONING',$5,$6)
         ON CONFLICT(owner_id,creation_key) DO UPDATE SET creation_key=EXCLUDED.creation_key RETURNING *`,
        [id, ownerId, timeZone, title, padId, key])).rows);
      if (created.title !== title || created.owner_timezone !== timeZone) {
        throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'The key belongs to another request');
      }
      return created;
    });
    if (document.status === 'READY') return this.documentSummary(document.id, ownerId);
    try {
      await this.etherpad.createPad(document.initial_pad_id);
    } catch (error) {
      if (!(error instanceof EtherpadError && error.upstreamCode === 1)) throw error;
      await this.etherpad.revisionCount(document.initial_pad_id);
    }
    await transaction(async (client) => {
      const locked = one((await client.query('SELECT * FROM business.documents WHERE id=$1 FOR UPDATE', [document.id])).rows);
      if (locked.status === 'READY') return;
      const branchId = randomUUID();
      const versionId = randomUUID();
      await client.query('INSERT INTO business.branches(id,document_id,number) VALUES($1,$2,1)', [branchId, document.id]);
      await client.query(
        "INSERT INTO business.versions(id,branch_id,number,pad_id,state) VALUES($1,$2,1,$3,'OPEN')",
        [versionId, branchId, document.initial_pad_id]);
      await client.query('UPDATE business.branches SET active_version_id=$2 WHERE id=$1', [branchId, versionId]);
      await client.query("UPDATE business.documents SET status='READY',next_daily_at=$2 WHERE id=$1",
        [document.id, nextLocalMidnight(document.owner_timezone, new Date())]);
    });
    return this.documentSummary(document.id, ownerId);
  }

  async documentSummary(documentId: string, userId: string): Promise<Row> {
    const result = await pool.query(
      `SELECT d.id,d.title,d.owner_id AS "ownerId",d.owner_timezone AS "ownerTimeZone",
              b.id AS "branchId",v.id AS "versionId",v.pad_id AS "padId",v.state
       FROM business.documents d JOIN business.branches b ON b.document_id=d.id AND b.number=1
       JOIN business.versions v ON v.id=b.active_version_id
       WHERE d.id=$1 AND d.owner_id=$2 AND d.status='READY'`, [documentId, userId]);
    return one(result.rows);
  }

  async listProjects(userId: string): Promise<Row[]> {
    return (await pool.query(
      `SELECT DISTINCT d.id AS "projectId",d.title,d.owner_timezone AS "ownerTimeZone",
              (d.owner_id=$1) AS "isOwner"
       FROM business.documents d JOIN business.branches b ON b.document_id=d.id
       LEFT JOIN business.permissions p ON p.branch_id=b.id AND p.user_id=$1
       WHERE d.status='READY' AND (d.owner_id=$1 OR p.access IS NOT NULL)
       ORDER BY d.title`, [userId])).rows;
  }

  async projectDetails(projectId: string, userId: string): Promise<Row> {
    const row = (await pool.query(
      `SELECT d.id AS "projectId",d.title,d.owner_timezone AS "ownerTimeZone",
              (d.owner_id=$2) AS "isOwner"
       FROM business.documents d
       WHERE d.id=$1 AND d.status='READY' AND
         (d.owner_id=$2 OR EXISTS (
           SELECT 1 FROM business.branches b JOIN business.permissions p ON p.branch_id=b.id
           WHERE b.document_id=d.id AND p.user_id=$2))`, [projectId, userId])).rows[0];
    if (!row) throw new DomainError(404, 'NOT_FOUND', 'Project not found');
    return row;
  }

  async branchAccess(branchId: string, userId: string, required: 'READ'|'WRITE'|'OWNER'): Promise<Row> {
    const result = await pool.query(
      `SELECT b.*,d.owner_id,d.title,p.access FROM business.branches b
       JOIN business.documents d ON d.id=b.document_id
       LEFT JOIN business.permissions p ON p.branch_id=b.id AND p.user_id=$2 WHERE b.id=$1`, [branchId, userId]);
    const branch = one(result.rows);
    const owner = branch.owner_id === userId;
    if (!owner && (required === 'OWNER' || !branch.access || (required === 'WRITE' && branch.access !== 'WRITE'))) {
      throw new DomainError(403, 'FORBIDDEN', 'Branch access is denied');
    }
    return branch;
  }

  async listBranches(documentId: string, userId: string): Promise<Row[]> {
    const result = await pool.query(
      `SELECT b.id,b.number,b.active_version_id AS "activeVersionId",b.source_branch_id AS "sourceBranchId",
              b.source_version_id AS "sourceVersionId",b.source_revision AS "sourceRevision"
       FROM business.branches b JOIN business.documents d ON d.id=b.document_id
       LEFT JOIN business.permissions p ON p.branch_id=b.id AND p.user_id=$2
       WHERE d.id=$1 AND (d.owner_id=$2 OR p.access IS NOT NULL) ORDER BY b.number`, [documentId, userId]);
    return result.rows;
  }

  async listVersions(branchId: string, userId: string): Promise<Row[]> {
    await this.branchAccess(branchId, userId, 'READ');
    return (await pool.query(
      'SELECT id,number,pad_id AS "padId",state,final_revision AS "finalRevision" FROM business.versions WHERE branch_id=$1 ORDER BY number',
      [branchId])).rows;
  }

  async versionContent(versionId: string, userId: string, revision?: number): Promise<Row> {
    const version = one((await pool.query('SELECT * FROM business.versions WHERE id=$1', [versionId])).rows);
    await this.branchAccess(version.branch_id, userId, 'READ');
    if (revision !== undefined && (revision < 0 || (version.final_revision !== null && revision > version.final_revision))) {
      throw new DomainError(400, 'INVALID_REVISION', 'Revision is outside the version history');
    }
    const [text, html] = await Promise.all([
      this.etherpad.getText(version.pad_id, revision), this.etherpad.getHtml(version.pad_id, revision),
    ]);
    return {versionId, revision: revision ?? await this.etherpad.revisionCount(version.pad_id), text, html};
  }

  async setPermission(branchId: string, ownerId: string, userId: string, access: 'READ'|'WRITE'|null): Promise<void> {
    const branch = await this.branchAccess(branchId, ownerId, 'OWNER');
    if (branch.owner_id === userId) throw new DomainError(400, 'OWNER_PERMISSION', 'Owner access cannot be changed');
    const target = await pool.query('SELECT 1 FROM business.users WHERE id=$1', [userId]);
    if (!target.rowCount) throw new DomainError(404, 'USER_NOT_FOUND', 'User not found');
    if (access) await pool.query(
      `INSERT INTO business.permissions(branch_id,user_id,access) VALUES($1,$2,$3)
       ON CONFLICT(branch_id,user_id) DO UPDATE SET access=EXCLUDED.access`, [branchId, userId, access]);
    else await pool.query('DELETE FROM business.permissions WHERE branch_id=$1 AND user_id=$2', [branchId, userId]);
  }

  async requestClosure(branchId: string, userId: string | null, cause: 'MANUAL'|'DAILY', key: string | null): Promise<Row> {
    const result = await transaction(async (client) => {
      const branch = one((await client.query(
        `SELECT b.*,d.owner_id FROM business.branches b JOIN business.documents d ON d.id=b.document_id
         WHERE b.id=$1 FOR UPDATE OF b`, [branchId])).rows);
      if (cause === 'MANUAL' && branch.owner_id !== userId) throw new DomainError(403, 'FORBIDDEN', 'Owner access is required');
      if (key) {
        const existing = await client.query('SELECT * FROM business.closures WHERE branch_id=$1 AND request_key=$2', [branchId, key]);
        if (existing.rows[0]) return existing.rows[0];
      }
      const current = one((await client.query('SELECT * FROM business.versions WHERE id=$1 FOR UPDATE', [branch.active_version_id])).rows);
      if (current.state === 'CLOSING') return one((await client.query('SELECT * FROM business.closures WHERE source_version_id=$1', [current.id])).rows);
      if (current.state !== 'OPEN') throw new DomainError(409, 'VERSION_NOT_OPEN', 'No open version exists');
      const id = randomUUID();
      const closure = one((await client.query(
        `INSERT INTO business.closures(id,branch_id,source_version_id,cause,state,requested_at,admission_deadline,destination_pad_id,request_key)
         VALUES($1,$2,$3,$4,'WAITING',clock_timestamp(),clock_timestamp()+interval '3 seconds',$5,$6) RETURNING *`,
        [id, branchId, current.id, cause, `business-${randomUUID()}`, key])).rows);
      await client.query("UPDATE business.versions SET state='CLOSING' WHERE id=$1", [current.id]);
      return closure;
    });
    const source = one((await pool.query('SELECT pad_id FROM business.versions WHERE id=$1', [result.source_version_id])).rows);
    await this.etherpad.announceClosing(source.pad_id).catch((error) => {
      console.warn('Closing announcement failed; server admission remains authoritative', error);
    });
    return result;
  }

  async closure(id: string, userId: string): Promise<Row> {
    const closure = one((await pool.query('SELECT * FROM business.closures WHERE id=$1', [id])).rows);
    await this.branchAccess(closure.branch_id, userId, 'READ');
    return closure;
  }

  async requestRestoration(versionId: string, userId: string, revision: number, key: string): Promise<Row> {
    const source = one((await pool.query(
      `SELECT v.*,b.document_id FROM business.versions v JOIN business.branches b ON b.id=v.branch_id WHERE v.id=$1`,
      [versionId])).rows);
    await this.branchAccess(source.branch_id, userId, 'OWNER');
    const head = source.final_revision ?? await this.etherpad.revisionCount(source.pad_id);
    if (!Number.isInteger(revision) || revision < 0 || revision > head) {
      throw new DomainError(400, 'INVALID_REVISION', 'Revision is outside the version history');
    }
    return transaction(async (client) => {
      await client.query('SELECT id FROM business.documents WHERE id=$1 FOR UPDATE', [source.document_id]);
      const existing = await client.query('SELECT * FROM business.restorations WHERE document_id=$1 AND request_key=$2', [source.document_id, key]);
      if (existing.rows[0]) {
        if (existing.rows[0].source_version_id !== versionId || existing.rows[0].source_revision !== revision) {
          throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'The key belongs to another request');
        }
        return existing.rows[0];
      }
      return one((await client.query(
        `INSERT INTO business.restorations(id,document_id,source_version_id,source_revision,destination_pad_id,state,request_key)
         VALUES($1,$2,$3,$4,$5,'COPYING',$6) RETURNING *`,
        [randomUUID(), source.document_id, versionId, revision, `business-${randomUUID()}`, key])).rows);
    });
  }

  async restoration(id: string, userId: string): Promise<Row> {
    const operation = one((await pool.query('SELECT * FROM business.restorations WHERE id=$1', [id])).rows);
    const owner = await pool.query('SELECT 1 FROM business.documents WHERE id=$1 AND owner_id=$2', [operation.document_id, userId]);
    if (!owner.rowCount) throw new DomainError(403, 'FORBIDDEN', 'Owner access is required');
    return operation;
  }

  async editorAccess(padId: string, token: string, write: boolean): Promise<Row> {
    if (!/^[0-9a-f]{64}$/.test(token)) throw new DomainError(403, 'FORBIDDEN', 'Pad access is denied');
    const result = await pool.query(
      `SELECT u.id AS user_id,v.state,c.admission_deadline,d.owner_id,p.access,
              (b.active_version_id=v.id) AS is_active,
              (v.state='OPEN' OR (v.state='CLOSING' AND c.admission_deadline>clock_timestamp())) AS accepts_writes
       FROM business.sessions s JOIN business.users u ON u.id=s.user_id
       JOIN business.versions v ON v.pad_id=$2
       JOIN business.branches b ON b.id=v.branch_id
       JOIN business.documents d ON d.id=b.document_id
       LEFT JOIN business.permissions p ON p.branch_id=b.id AND p.user_id=u.id
       LEFT JOIN business.closures c ON c.source_version_id=v.id
       WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()`, [tokenHash(token), padId]);
    const row = result.rows[0];
    if (!row || (row.owner_id !== row.user_id && (!row.access || (write && row.access !== 'WRITE')))) {
      throw new DomainError(403, 'FORBIDDEN', 'Pad access is denied');
    }
    if (write && (!row.is_active || !row.accepts_writes)) {
      throw new DomainError(409, 'VERSION_NOT_OPEN', 'The version no longer accepts writing');
    }
    return {userId: row.user_id, write: row.owner_id === row.user_id || row.access === 'WRITE', state: row.state};
  }

  private async barrier(padId: string): Promise<number> {
    const response = await fetch(new URL('/business-internal/barrier', this.etherpadApiUrl), {
      method: 'POST', headers: {'content-type': 'application/json', 'x-internal-key': this.internalKey},
      body: JSON.stringify({padId}), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Etherpad barrier returned HTTP ${response.status}`);
    const data = await response.json() as {revision: number};
    if (!Number.isInteger(data.revision)) throw new Error('Etherpad barrier returned no revision');
    return data.revision;
  }

  async processClosures(): Promise<void> {
    const ready = await pool.query(
      `SELECT id FROM business.closures WHERE state IN ('WAITING','DRAINING','COPYING','FAILED')
       AND admission_deadline<=clock_timestamp() AND (retry_after IS NULL OR retry_after<=clock_timestamp())
       ORDER BY admission_deadline LIMIT 20`);
    for (const row of ready.rows) await this.processClosure(row.id).catch(async (error) => {
      await pool.query("UPDATE business.closures SET state='FAILED',last_error=$2,retry_after=clock_timestamp()+interval '5 seconds' WHERE id=$1", [row.id, String(error)]);
    });
  }

  private async processClosure(id: string): Promise<void> {
    const client = await pool.connect();
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [id]);
      if (!lock.rows[0]?.locked) return;
      const operation = one((await client.query('SELECT * FROM business.closures WHERE id=$1', [id])).rows);
      if (operation.state === 'COMPLETED') return;
      const source = one((await client.query('SELECT * FROM business.versions WHERE id=$1', [operation.source_version_id])).rows);
      let finalRevision = operation.final_revision as number | null;
      if (finalRevision === null) {
        await client.query("UPDATE business.closures SET state='DRAINING' WHERE id=$1", [id]);
        finalRevision = await this.barrier(source.pad_id);
        await client.query(
          "UPDATE business.closures SET state='COPYING',final_revision=$2 WHERE id=$1", [id, finalRevision]);
      }
      try {
        await this.etherpad.copyWithoutHistory(source.pad_id, operation.destination_pad_id);
      } catch (error) {
        if (!(error instanceof EtherpadError && error.upstreamCode === 1)) throw error;
      }
      const [expectedText, actualText, expectedHtml, actualHtml] = await Promise.all([
        this.etherpad.getText(source.pad_id, finalRevision),
        this.etherpad.getText(operation.destination_pad_id),
        this.etherpad.getHtml(source.pad_id, finalRevision),
        this.etherpad.getHtml(operation.destination_pad_id),
      ]);
      if (expectedText !== actualText || expectedHtml !== actualHtml) {
        throw new Error('Destination pad does not match the final revision');
      }
      await transaction(async (tx) => {
        const closure = one((await tx.query('SELECT * FROM business.closures WHERE id=$1 FOR UPDATE', [id])).rows);
        if (closure.state === 'COMPLETED') return;
        const branch = one((await tx.query('SELECT * FROM business.branches WHERE id=$1 FOR UPDATE', [closure.branch_id])).rows);
        const successorId = randomUUID();
        await tx.query("UPDATE business.versions SET state='FROZEN',final_revision=$2 WHERE id=$1", [source.id, finalRevision]);
        await tx.query("INSERT INTO business.versions(id,branch_id,number,pad_id,state) VALUES($1,$2,$3,$4,'OPEN')",
          [successorId, branch.id, source.number + 1, closure.destination_pad_id]);
        await tx.query('UPDATE business.branches SET active_version_id=$2 WHERE id=$1', [branch.id, successorId]);
        await tx.query("UPDATE business.closures SET state='COMPLETED',successor_version_id=$2,last_error=NULL WHERE id=$1",
          [id, successorId]);
      });
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [id]).catch(() => {});
      client.release();
    }
  }

  async processRestorations(): Promise<void> {
    const pending = await pool.query("SELECT id FROM business.restorations WHERE state IN ('COPYING','FAILED') AND (retry_after IS NULL OR retry_after<=clock_timestamp()) LIMIT 20");
    for (const row of pending.rows) await this.processRestoration(row.id).catch(async (error) => {
      await pool.query("UPDATE business.restorations SET state='FAILED',last_error=$2,retry_after=clock_timestamp()+interval '5 seconds' WHERE id=$1", [row.id, String(error)]);
    });
  }

  private async processRestoration(id: string): Promise<void> {
    const client = await pool.connect();
    const tempPad = `temporary-${id}`;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [id]);
      if (!lock.rows[0]?.locked) return;
      const operation = one((await client.query('SELECT * FROM business.restorations WHERE id=$1', [id])).rows);
      if (operation.state === 'COMPLETED') return;
      const source = one((await client.query('SELECT * FROM business.versions WHERE id=$1', [operation.source_version_id])).rows);
      try {
        if (source.state === 'FROZEN' && operation.source_revision === source.final_revision) {
          await this.etherpad.copyWithoutHistory(source.pad_id, operation.destination_pad_id);
        } else {
          try { await this.etherpad.deletePad(tempPad); } catch { /* The temporary pad may not exist. */ }
          await this.etherpad.copyWithHistory(source.pad_id, tempPad);
          await this.etherpad.restoreRevision(tempPad, operation.source_revision);
          await this.etherpad.copyWithoutHistory(tempPad, operation.destination_pad_id);
          await this.etherpad.deletePad(tempPad);
        }
      } catch (error) {
        if (!(error instanceof EtherpadError && error.upstreamCode === 1)) throw error;
      }
      const [sourceText, destinationText, sourceHtml, destinationHtml] = await Promise.all([
        this.etherpad.getText(source.pad_id, operation.source_revision),
        this.etherpad.getText(operation.destination_pad_id),
        this.etherpad.getHtml(source.pad_id, operation.source_revision),
        this.etherpad.getHtml(operation.destination_pad_id),
      ]);
      if (sourceText !== destinationText || sourceHtml !== destinationHtml) {
        throw new Error('Restored pad does not match its source revision');
      }
      await transaction(async (tx) => {
        const restoration = one((await tx.query('SELECT * FROM business.restorations WHERE id=$1 FOR UPDATE', [id])).rows);
        if (restoration.state === 'COMPLETED') return;
        await tx.query('SELECT id FROM business.documents WHERE id=$1 FOR UPDATE', [operation.document_id]);
        const count = await tx.query('SELECT COALESCE(max(number),0)+1 AS next FROM business.branches WHERE document_id=$1', [operation.document_id]);
        const branchId = randomUUID();
        const versionId = randomUUID();
        await tx.query(
          `INSERT INTO business.branches(id,document_id,number,source_branch_id,source_version_id,source_revision)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [branchId, operation.document_id, count.rows[0].next, source.branch_id, source.id, operation.source_revision]);
        await tx.query("INSERT INTO business.versions(id,branch_id,number,pad_id,state) VALUES($1,$2,1,$3,'OPEN')",
          [versionId, branchId, operation.destination_pad_id]);
        await tx.query('UPDATE business.branches SET active_version_id=$2 WHERE id=$1', [branchId, versionId]);
        await tx.query("UPDATE business.restorations SET state='COMPLETED',destination_branch_id=$2,last_error=NULL WHERE id=$1", [id, branchId]);
      });
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [id]).catch(() => {});
      client.release();
    }
  }

  async scheduleDaily(): Promise<void> {
    const due = await pool.query('SELECT * FROM business.documents WHERE status=\'READY\' AND next_daily_at<=clock_timestamp()');
    for (const document of due.rows) {
      const branches = await pool.query('SELECT id FROM business.branches WHERE document_id=$1', [document.id]);
      const key = `daily:${document.id}:${new Date(document.next_daily_at).toISOString()}`;
      for (const branch of branches.rows) await this.requestClosure(branch.id, null, 'DAILY', key);
      await pool.query('UPDATE business.documents SET next_daily_at=$2 WHERE id=$1',
        [document.id, nextLocalMidnight(document.owner_timezone, new Date())]);
    }
  }
}
