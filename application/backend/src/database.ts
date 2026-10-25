import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';

export const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA IF NOT EXISTS business');
    await client.query('CREATE TABLE IF NOT EXISTS business.schema_migrations (name text PRIMARY KEY)');
    const directory = new URL('../migrations/', import.meta.url).pathname;
    for (const name of readdirSync(directory).filter((item) => item.endsWith('.sql')).sort()) {
      const found = await client.query('SELECT 1 FROM business.schema_migrations WHERE name = $1', [name]);
      if (found.rowCount) continue;
      await client.query(readFileSync(join(directory, name), 'utf8'));
      await client.query('INSERT INTO business.schema_migrations(name) VALUES ($1)', [name]);
    }
    await client.query('COMMIT');
    const {getMigrations} = await import('better-auth/db/migration');
    const {auth} = await import('./better-auth.js');
    const {runMigrations} = await getMigrations(auth.options);
    await runMigrations();
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith('/database.js')) {
  migrate().then(() => pool.end()).catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
}
