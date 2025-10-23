import dotenv from 'dotenv';
dotenv.config();

// Default table names
const DEFAULT_TABLES = {
  QUEUE: 'queue',
  MEMORY: 'memory',
};

// Get table name from environment variable or fall back to default
const getTableName = (envVar, defaultName) => process.env[envVar] || defaultName;

// Export configured table names
export const DB_TABLES = {
  QUEUE: getTableName('SUPABASE_QUEUE_TABLE', DEFAULT_TABLES.QUEUE),
  MEMORY: getTableName('SUPABASE_MEMORY_TABLE', DEFAULT_TABLES.MEMORY),
};

// Export function to validate table existence
export const validateTables = async (supabase) => {
  const tables = [DB_TABLES.QUEUE, DB_TABLES.MEMORY];

  const results = await Promise.all(
    tables.map(async (table) => {
      const { error } = await supabase.from(table).select('*').limit(1);
      return { table, exists: !error };
    })
  );

  const missingTables = results.filter(({ exists }) => !exists).map(({ table }) => table);

  if (missingTables.length > 0) {
    throw new Error(`Missing required tables: ${missingTables.join(', ')}`);
  }

  return true;
};
