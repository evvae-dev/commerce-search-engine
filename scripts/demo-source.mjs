import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function demoDatabasePath() {
  return resolve(process.env.DEMO_DB_PATH || '.demo/catalog.sqlite');
}

export function openDemoDatabase({ readOnly = true } = {}) {
  const path = demoDatabasePath();
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path, { readOnly, timeout: 5000 });
  if (readOnly) database.exec('PRAGMA query_only = ON');
  return database;
}

export const DEMO_FULL_QUERY = 'SELECT * FROM DEMO_PRODUCTS WHERE ACTIVE = 1';
export const DEMO_ADD_QUERY = `SELECT P.* FROM DEMO_PRODUCTS P
JOIN DEMO_SYNC_QUEUE Q ON Q.GOODS_ID = P.GOODS_ID
WHERE Q.CLAIM_ID = :claim_id AND Q.UPDATE_STATE = 'RUNNING' AND P.ACTIVE = 1`;
export const DEMO_DELETE_QUERY = `SELECT P.GOODS_ID FROM DEMO_PRODUCTS P
JOIN DEMO_SYNC_QUEUE Q ON Q.GOODS_ID = P.GOODS_ID
WHERE Q.CLAIM_ID = :claim_id AND Q.UPDATE_STATE = 'RUNNING' AND P.ACTIVE = 0`;
