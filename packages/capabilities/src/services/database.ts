import { getDatabase } from '@coachartie/shared';

// Re-export the database instance for easier imports within capabilities
export const database: Awaited<ReturnType<typeof getDatabase>> = await getDatabase();