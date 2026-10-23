import { getSyncDb, type SyncDbWrapper } from '../../shared/db/client.js';

// Use the synchronous better-sqlite3 wrapper instead of deprecated sql.js
// This prevents database corruption caused by sql.js overwriting better-sqlite3 changes
export const database: SyncDbWrapper = getSyncDb();
