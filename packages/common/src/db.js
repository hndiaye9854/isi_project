import pg from 'pg';
import { sleep } from './config.js';

/** Pool PostgreSQL avec attente de disponibilité puis migration du schéma. */
export async function createDb({ url, logger, schema, attempts = 30 }) {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (i === attempts) throw err;
      logger.warn({ err: err.message, tentative: i }, 'Base de données indisponible, nouvelle tentative');
      await sleep(2000);
    }
  }
  if (schema) await pool.query(schema);
  logger.info('Base de données prête');
  return pool;
}

/** Exécute une fonction dans une transaction. */
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
