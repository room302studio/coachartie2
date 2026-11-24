// Read side of the global variable store. retry.ts interpolates `${var}` / `{{var}}` in tool
// params from it. The `variable` tool and the XML `output=` writers are gone, so nothing writes
// the scoped keys any more; the global_variables table stays.
import { getDb, asc } from '../../shared/db/client.js';
import { globalVariables } from '../../shared/db/schema.js';

/**
 * Key prefix for a tool result saved with `output="name"`: scoped to the person and server that
 * ran it, so `{{name}}` in one person's call can't read another's result (Codex crew
 * 2026-11-18: outputs were global and interpolation exposed every stored variable to everyone).
 */
export function scopedOutputPrefix(userId: string, guildId?: string | null): string {
  return `out:${userId}:${guildId || 'dm'}:`;
}

export class GlobalVariableStore {
  private static instance: GlobalVariableStore;

  static getInstance(): GlobalVariableStore {
    if (!GlobalVariableStore.instance) {
      GlobalVariableStore.instance = new GlobalVariableStore();
    }
    return GlobalVariableStore.instance;
  }

  /**
   * Shutdown method for graceful cleanup (no-op for DB-backed store)
   */
  shutdown(): void {
    // DB-backed store doesn't need cleanup
  }

  /**
   * List all variables
   */
  async list(): Promise<Record<string, any>> {
    const db = getDb();
    const rows = await db
      .select({
        key: globalVariables.key,
        value: globalVariables.value,
        valueType: globalVariables.valueType,
        description: globalVariables.description,
      })
      .from(globalVariables)
      .orderBy(asc(globalVariables.key));

    const variables: Record<string, any> = {};
    for (const row of rows) {
      let value: any = row.value;
      switch (row.valueType) {
        case 'json':
          value = JSON.parse(row.value);
          break;
        case 'number':
          value = Number(row.value);
          break;
        case 'boolean':
          value = row.value === 'true';
          break;
      }
      variables[row.key] = value;
    }

    return variables;
  }
}
