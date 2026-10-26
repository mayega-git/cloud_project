import {randomBytes, randomUUID} from 'node:crypto';
import {pool} from '../database.js';
import {EtherpadClient} from '../etherpad.js';
import {tokenHash} from './auth.js';
import {DomainError} from './errors.js';
import {textToPdf} from './pdf.js';

const tokenPattern = /^[0-9a-f]{64}$/;

export interface LinkSummary {id: string; maxDownloads: number; remaining: number; createdAt: string}

// A download is consumed when the link is reserved, before any conversion work, so an
// exhausted link costs nothing. If the PDF cannot be produced, the unit is given back.
export class DownloadService {
  constructor(private readonly etherpad: EtherpadClient) {}

  async createLink(userId: string, branchId: string, maxDownloads: number): Promise<{id: string; token: string}> {
    if (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > 1_000_000) {
      throw new DomainError(400, 'INVALID_LIMIT', 'maxDownloads must be an integer between 1 and 1000000');
    }
    await this.assertOwner(userId, branchId);
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO business.download_links(id, branch_id, created_by, token_hash, max_downloads, remaining)
       VALUES ($1,$2,$3,$4,$5,$5)`, [id, branchId, userId, tokenHash(token), maxDownloads]);
    return {id, token};
  }

  async listLinks(userId: string, branchId: string): Promise<LinkSummary[]> {
    await this.assertOwner(userId, branchId);
    const result = await pool.query(
      `SELECT id, max_downloads AS "maxDownloads", remaining, created_at AS "createdAt"
       FROM business.download_links WHERE branch_id=$1 ORDER BY created_at`, [branchId]);
    return result.rows as LinkSummary[];
  }

  async status(token: string): Promise<{state: 'AVAILABLE' | 'EXHAUSTED'; remaining: number}> {
    const row = await this.find(token);
    return {state: row.remaining > 0 ? 'AVAILABLE' : 'EXHAUSTED', remaining: row.remaining};
  }

  async download(token: string): Promise<{pdf: Buffer; remaining: number}> {
    if (!tokenPattern.test(token)) throw new DomainError(404, 'NOT_FOUND', 'Link not found');
    const reserved = await pool.query(
      `UPDATE business.download_links SET remaining = remaining - 1
       WHERE token_hash=$1 AND remaining > 0 RETURNING id, branch_id, remaining`, [tokenHash(token)]);
    const link = reserved.rows[0] as {id: string; branch_id: string; remaining: number} | undefined;
    if (!link) {
      await this.find(token); // 404 if the link does not exist
      throw new DomainError(410, 'LINK_EXHAUSTED', 'No download remains for this link');
    }
    try {
      const active = await pool.query(
        `SELECT v.pad_id FROM business.branches b JOIN business.versions v ON v.id=b.active_version_id
         WHERE b.id=$1`, [link.branch_id]);
      const padId = (active.rows[0] as {pad_id: string} | undefined)?.pad_id;
      if (!padId) throw new DomainError(404, 'NOT_FOUND', 'The document has no active version');
      const text = await this.etherpad.getText(padId);
      return {pdf: textToPdf(text), remaining: link.remaining};
    } catch (error) {
      await pool.query(
        'UPDATE business.download_links SET remaining = remaining + 1 WHERE id=$1 AND remaining < max_downloads', [link.id]);
      throw error;
    }
  }

  private async find(token: string): Promise<{remaining: number}> {
    if (!tokenPattern.test(token)) throw new DomainError(404, 'NOT_FOUND', 'Link not found');
    const result = await pool.query('SELECT remaining FROM business.download_links WHERE token_hash=$1', [tokenHash(token)]);
    const row = result.rows[0] as {remaining: number} | undefined;
    if (!row) throw new DomainError(404, 'NOT_FOUND', 'Link not found');
    return row;
  }

  private async assertOwner(userId: string, branchId: string): Promise<void> {
    const result = await pool.query(
      `SELECT 1 FROM business.branches b JOIN business.documents d ON d.id=b.document_id
       WHERE b.id=$1 AND d.owner_id=$2`, [branchId, userId]);
    if (!result.rowCount) throw new DomainError(403, 'FORBIDDEN', 'Only the owner can manage download links');
  }
}
