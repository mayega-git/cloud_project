import {pool} from '../database.js';
import {DomainError} from './errors.js';

export const WRITE_CREDIT_LIMIT = Number(process.env.WRITE_CREDIT_LIMIT ?? '10000');

// Debit rule: a change costs the number of characters it inserts. Deletions and
// formatting cost nothing. A change that would exceed the credit is refused whole.
// The quota day is the UTC day, independent of the versioning day.
export class WriteCreditService {
  async debit(userId: string, cost: number): Promise<number> {
    if (!Number.isInteger(cost) || cost < 0) throw new DomainError(400, 'INVALID_COST', 'Cost must be a nonnegative integer');
    if (cost === 0) return this.remaining(userId);
    if (cost > WRITE_CREDIT_LIMIT) throw new DomainError(403, 'CREDIT_EXHAUSTED', 'The daily writing credit is exhausted');
    // Single statement: concurrent debits from several devices serialize on the row,
    // and the WHERE clause is re-evaluated against the latest committed value.
    const result = await pool.query(
      `INSERT INTO business.write_credit(user_id, quota_day, used)
       VALUES ($1, (clock_timestamp() AT TIME ZONE 'UTC')::date, $2)
       ON CONFLICT (user_id, quota_day)
       DO UPDATE SET used = business.write_credit.used + EXCLUDED.used
       WHERE business.write_credit.used + EXCLUDED.used <= $3
       RETURNING used`, [userId, cost, WRITE_CREDIT_LIMIT]);
    const row = result.rows[0] as {used: number} | undefined;
    if (!row) throw new DomainError(403, 'CREDIT_EXHAUSTED', 'The daily writing credit is exhausted');
    return WRITE_CREDIT_LIMIT - row.used;
  }

  async remaining(userId: string): Promise<number> {
    const result = await pool.query(
      `SELECT used FROM business.write_credit
       WHERE user_id=$1 AND quota_day=(clock_timestamp() AT TIME ZONE 'UTC')::date`, [userId]);
    return WRITE_CREDIT_LIMIT - ((result.rows[0] as {used: number} | undefined)?.used ?? 0);
  }
}
