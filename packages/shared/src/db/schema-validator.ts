import { Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';

/**
 * Schema validation results
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  summary: {
    tablesChecked: number;
    indexesChecked: number;
    constraintsChecked: number;
    foreignKeysChecked: number;
    triggersChecked: number;
  };
}

export interface ValidationError {
  type: 'missing_table' | 'missing_column' | 'missing_index' | 'missing_trigger' | 'constraint_violation' | 'foreign_key_error' | 'data_integrity';
  table?: string;
  column?: string;
  constraint?: string;
  message: string;
  severity: 'critical' | 'major' | 'minor';
}

export interface ValidationWarning {
  type: 'performance' | 'data_quality' | 'schema_drift' | 'deprecated';
  table?: string;
  message: string;
}

/**
 * Expected schema definition
 */
interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  triggers?: TriggerSchema[];
  foreignKeys?: ForeignKeySchema[];
}

interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  primaryKey?: boolean;
  unique?: boolean;
}

interface IndexSchema {
  name: string;
  columns: string[];
  unique?: boolean;
}

interface TriggerSchema {
  name: string;
  event: string; // 'INSERT', 'UPDATE', 'DELETE'
  timing: string; // 'BEFORE', 'AFTER'
}

interface ForeignKeySchema {
  column: string;
  referencedTable: string;
  referencedColumn: string;
  onDelete?: string;
}

/**
 * Coach Artie database schema validator
 * Like a health inspector for our data kitchen - ensures everything is properly seasoned!
 */
export class SchemaValidator {
  private db: Database<sqlite3.Database, sqlite3.Statement>;

  constructor(database: Database<sqlite3.Database, sqlite3.Statement>) {
    this.db = database;
  }

  /**
   * Validate the complete database schema against expected structure
   */
  async validateSchema(): Promise<ValidationResult> {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      summary: {
        tablesChecked: 0,
        indexesChecked: 0,
        constraintsChecked: 0,
        foreignKeysChecked: 0,
        triggersChecked: 0
      }
    };

    try {
      logger.info('🔍 Starting comprehensive schema validation...');

      // Validate all expected tables
      await this.validateTables(result);
      
      // Validate indexes for performance
      await this.validateIndexes(result);
      
      // Check triggers for data integrity
      await this.validateTriggers(result);
      
      // Validate foreign keys
      await this.validateForeignKeys(result);
      
      // Check data integrity constraints
      await this.validateDataIntegrity(result);
      
      // Performance checks
      await this.validatePerformance(result);

      result.isValid = result.errors.filter(e => e.severity === 'critical').length === 0;

      const errorCount = result.errors.length;
      const warningCount = result.warnings.length;
      
      if (result.isValid) {
        logger.info(`✅ Schema validation passed! (${warningCount} warnings)`);
      } else {
        logger.error(`❌ Schema validation failed! (${errorCount} errors, ${warningCount} warnings)`);
      }

      return result;
    } catch (error) {
      logger.error('Schema validation failed:', error);
      result.errors.push({
        type: 'data_integrity',
        message: `Schema validation crashed: ${error}`,
        severity: 'critical'
      });
      result.isValid = false;
      return result;
    }
  }

  /**
   * Validate all expected tables exist with correct structure
   */
  private async validateTables(result: ValidationResult): Promise<void> {
    const expectedTables = this.getExpectedSchema();

    for (const expectedTable of expectedTables) {
      result.summary.tablesChecked++;

      // Check if table exists
      const tableExists = await this.db.get(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        [expectedTable.name]
      );

      if (!tableExists) {
        result.errors.push({
          type: 'missing_table',
          table: expectedTable.name,
          message: `Required table '${expectedTable.name}' is missing`,
          severity: 'critical'
        });
        continue;
      }

      // Validate table structure
      await this.validateTableStructure(expectedTable, result);
    }
  }

  /**
   * Validate individual table structure
   */
  private async validateTableStructure(expectedTable: TableSchema, result: ValidationResult): Promise<void> {
    try {
      const columns = await this.db.all(`PRAGMA table_info(${expectedTable.name})`);
      const columnMap = new Map(columns.map((col: any) => [col.name, col]));

      for (const expectedColumn of expectedTable.columns) {
        const actualColumn = columnMap.get(expectedColumn.name);

        if (!actualColumn) {
          result.errors.push({
            type: 'missing_column',
            table: expectedTable.name,
            column: expectedColumn.name,
            message: `Column '${expectedColumn.name}' missing from table '${expectedTable.name}'`,
            severity: 'critical'
          });
          continue;
        }

        // Type checking (basic)
        const actualType = actualColumn.type.toUpperCase();
        const expectedType = expectedColumn.type.toUpperCase();
        
        if (!this.typesMatch(actualType, expectedType)) {
          result.warnings.push({
            type: 'schema_drift',
            table: expectedTable.name,
            message: `Column '${expectedColumn.name}' has type '${actualType}' but expected '${expectedType}'`
          });
        }

        // Nullable check
        const isNullable = actualColumn.notnull === 0;
        if (isNullable !== expectedColumn.nullable) {
          result.warnings.push({
            type: 'schema_drift',
            table: expectedTable.name,
            message: `Column '${expectedColumn.name}' nullable mismatch: got ${isNullable}, expected ${expectedColumn.nullable}`
          });
        }
      }
    } catch (error) {
      result.errors.push({
        type: 'data_integrity',
        table: expectedTable.name,
        message: `Failed to validate table structure: ${error}`,
        severity: 'major'
      });
    }
  }

  /**
   * Validate critical indexes exist
   */
  private async validateIndexes(result: ValidationResult): Promise<void> {
    const expectedTables = this.getExpectedSchema();

    for (const table of expectedTables) {
      for (const expectedIndex of table.indexes) {
        result.summary.indexesChecked++;

        const indexExists = await this.db.get(
          `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
          [expectedIndex.name]
        );

        if (!indexExists) {
          result.errors.push({
            type: 'missing_index',
            table: table.name,
            message: `Critical index '${expectedIndex.name}' missing from table '${table.name}'`,
            severity: 'major'
          });
        }
      }
    }

    // Check for unused indexes (performance warning)
    const allIndexes = await this.db.all(`
      SELECT name, tbl_name FROM sqlite_master 
      WHERE type='index' AND name NOT LIKE 'sqlite_%'
    `);

    for (const index of allIndexes) {
      // This would require query log analysis to determine if unused
      // For now, just warn about suspicious patterns
      if (index.name.includes('temp') || index.name.includes('old')) {
        result.warnings.push({
          type: 'performance',
          table: index.tbl_name,
          message: `Suspicious index name '${index.name}' - may be temporary or unused`
        });
      }
    }
  }

  /**
   * Validate essential triggers exist
   */
  private async validateTriggers(result: ValidationResult): Promise<void> {
    const expectedTriggers = [
      'update_memories_timestamp',
      'update_prompts_timestamp',
      'create_prompt_history',
      'memories_fts_insert',
      'memories_fts_update',
      'memories_fts_delete'
    ];

    for (const triggerName of expectedTriggers) {
      result.summary.triggersChecked++;

      const triggerExists = await this.db.get(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`,
        [triggerName]
      );

      if (!triggerExists) {
        result.errors.push({
          type: 'missing_trigger',
          message: `Critical trigger '${triggerName}' is missing`,
          severity: 'major'
        });
      }
    }
  }

  /**
   * Validate foreign key constraints
   */
  private async validateForeignKeys(result: ValidationResult): Promise<void> {
    // Enable foreign key checking
    await this.db.run('PRAGMA foreign_keys = ON');

    try {
      // Check foreign key violations
      const violations = await this.db.all('PRAGMA foreign_key_check');
      
      for (const violation of violations) {
        result.summary.foreignKeysChecked++;
        result.errors.push({
          type: 'foreign_key_error',
          table: violation.table,
          message: `Foreign key violation in table '${violation.table}': ${violation.fkid}`,
          severity: 'critical'
        });
      }

      // Validate expected foreign keys exist
      const expectedFKs = [
        { table: 'messages', column: 'user_id', references: 'user_identities(id)' },
        { table: 'memories', column: 'user_id', references: 'user_identities(id)' },
        { table: 'prompt_history', column: 'prompt_id', references: 'prompts(id)' }
      ];

      for (const fk of expectedFKs) {
        const fkInfo = await this.db.all(`PRAGMA foreign_key_list(${fk.table})`);
        const hasExpectedFK = fkInfo.some((info: any) => info.from === fk.column);
        
        if (!hasExpectedFK) {
          result.warnings.push({
            type: 'data_quality',
            table: fk.table,
            message: `Expected foreign key ${fk.column} → ${fk.references} not found`
          });
        }
      }
    } catch (error) {
      result.errors.push({
        type: 'foreign_key_error',
        message: `Foreign key validation failed: ${error}`,
        severity: 'major'
      });
    }
  }

  /**
   * Validate data integrity constraints
   */
  private async validateDataIntegrity(result: ValidationResult): Promise<void> {
    const checks = [
      {
        name: 'orphaned_messages',
        sql: `SELECT COUNT(*) as count FROM messages m 
              LEFT JOIN user_identities u ON m.user_id = u.id 
              WHERE u.id IS NULL`,
        message: 'Orphaned messages without valid user_id'
      },
      {
        name: 'orphaned_memories', 
        sql: `SELECT COUNT(*) as count FROM memories m 
              LEFT JOIN user_identities u ON m.user_id = u.id 
              WHERE u.id IS NULL`,
        message: 'Orphaned memories without valid user_id'
      },
      {
        name: 'invalid_importance',
        sql: `SELECT COUNT(*) as count FROM memories 
              WHERE importance < 1 OR importance > 10`,
        message: 'Memories with invalid importance scores'
      },
      {
        name: 'invalid_queue_status',
        sql: `SELECT COUNT(*) as count FROM queue 
              WHERE status NOT IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')`,
        message: 'Queue items with invalid status'
      },
      {
        name: 'invalid_json_tags',
        sql: `SELECT COUNT(*) as count FROM memories 
              WHERE tags NOT LIKE '[%' AND tags NOT LIKE '{%' AND tags != '[]'`,
        message: 'Memories with malformed JSON tags'
      }
    ];

    for (const check of checks) {
      try {
        const checkResult = await this.db.get(check.sql);
        
        if (checkResult?.count > 0) {
          result.errors.push({
            type: 'constraint_violation',
            message: `${check.message}: ${checkResult.count} violations found`,
            severity: 'major'
          });
        }
        
        result.summary.constraintsChecked++;
      } catch (error) {
        result.warnings.push({
          type: 'data_quality',
          message: `Data integrity check '${check.name}' failed: ${error}`
        });
      }
    }
  }

  /**
   * Validate database performance characteristics  
   */
  private async validatePerformance(result: ValidationResult): Promise<void> {
    try {
      // Check table sizes for performance impact
      const tableSizes = await this.db.all(`
        SELECT name, 
               (SELECT COUNT(*) FROM pragma_table_info(name)) as column_count,
               rootpage
        FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `);

      for (const table of tableSizes) {
        // Check for very wide tables (>50 columns)
        if (table.column_count > 50) {
          result.warnings.push({
            type: 'performance',
            table: table.name,
            message: `Table '${table.name}' has ${table.column_count} columns - consider normalization`
          });
        }
      }

      // Check for missing ANALYZE statistics
      const analyzeStats = await this.db.get(`SELECT name FROM sqlite_master WHERE name='sqlite_stat1'`);
      if (!analyzeStats) {
        result.warnings.push({
          type: 'performance',
          message: 'Database lacks ANALYZE statistics - run ANALYZE for better query planning'
        });
      }

      // Check WAL mode is enabled
      const walMode = await this.db.get('PRAGMA journal_mode');
      if (walMode?.journal_mode !== 'wal') {
        result.warnings.push({
          type: 'performance',
          message: `Journal mode is '${walMode?.journal_mode}' - WAL mode recommended for better concurrency`
        });
      }

    } catch (error) {
      result.warnings.push({
        type: 'performance',
        message: `Performance validation failed: ${error}`
      });
    }
  }

  /**
   * Run automatic fixes for common issues
   */
  async autoFix(validationResult: ValidationResult): Promise<{ fixed: number; failed: number }> {
    let fixed = 0;
    let failed = 0;

    logger.info('🔧 Running automatic schema fixes...');

    for (const error of validationResult.errors) {
      try {
        switch (error.type) {
          case 'missing_index':
            if (error.table && this.canAutoCreateIndex(error)) {
              await this.createMissingIndex(error);
              fixed++;
              logger.info(`✅ Auto-created missing index for ${error.table}`);
            }
            break;

          case 'constraint_violation':
            if (error.message.includes('invalid JSON tags')) {
              await this.fixInvalidJsonTags();
              fixed++;
              logger.info('✅ Fixed invalid JSON tags');
            }
            break;

          default:
            // Skip auto-fix for critical structural issues
            break;
        }
      } catch (fixError) {
        logger.error(`Failed to auto-fix ${error.type}:`, fixError);
        failed++;
      }
    }

    logger.info(`🔧 Auto-fix complete: ${fixed} fixed, ${failed} failed`);
    return { fixed, failed };
  }

  /**
   * Generate TypeScript interfaces from current schema
   */
  async generateTypeScriptTypes(): Promise<string> {
    const tables = await this.db.all(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    let typescript = `// Auto-generated TypeScript types from Coach Artie schema\n`;
    typescript += `// Generated at: ${new Date().toISOString()}\n\n`;

    for (const table of tables) {
      const columns = await this.db.all(`PRAGMA table_info(${table.name})`);
      
      const interfaceName = this.toPascalCase(table.name);
      typescript += `export interface ${interfaceName} {\n`;

      for (const column of columns) {
        const tsType = this.sqliteToTypeScript(column.type);
        const optional = column.notnull === 0 ? '?' : '';
        typescript += `  ${column.name}${optional}: ${tsType};\n`;
      }

      typescript += `}\n\n`;
    }

    return typescript;
  }

  /**
   * Helper: Check if types are compatible
   */
  private typesMatch(actual: string, expected: string): boolean {
    // SQLite is flexible with types, so be lenient
    const normalizeType = (type: string) => {
      return type.replace(/\([^)]*\)/g, '').trim().toUpperCase();
    };

    return normalizeType(actual) === normalizeType(expected);
  }

  /**
   * Helper: Check if we can safely auto-create an index
   */
  private canAutoCreateIndex(error: ValidationError): boolean {
    // Only auto-create basic indexes, not complex ones
    return !!error.message && !error.message.includes('unique');
  }

  /**
   * Helper: Create missing index
   */
  private async createMissingIndex(error: ValidationError): Promise<void> {
    // This would need specific logic based on the error
    // For demo purposes, skip actual creation
    throw new Error('Index auto-creation not implemented');
  }

  /**
   * Helper: Fix invalid JSON tags
   */
  private async fixInvalidJsonTags(): Promise<void> {
    await this.db.run(`
      UPDATE memories 
      SET tags = '[]' 
      WHERE tags NOT LIKE '[%' AND tags NOT LIKE '{%' AND tags != '[]'
    `);
  }

  /**
   * Helper: Convert table name to PascalCase
   */
  private toPascalCase(str: string): string {
    return str.split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }

  /**
   * Helper: Convert SQLite types to TypeScript
   */
  private sqliteToTypeScript(sqliteType: string): string {
    const type = sqliteType.toUpperCase();
    
    if (type.includes('INT')) return 'number';
    if (type.includes('REAL') || type.includes('FLOAT')) return 'number';
    if (type.includes('BOOL')) return 'boolean';
    if (type.includes('TEXT') || type.includes('VARCHAR')) return 'string';
    if (type.includes('BLOB')) return 'Buffer';
    if (type.includes('JSON')) return 'any'; // Could be more specific
    
    return 'any'; // Fallback
  }

  /**
   * Get expected schema definition
   */
  private getExpectedSchema(): TableSchema[] {
    return [
      {
        name: 'user_identities',
        columns: [
          { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
          { name: 'discord_id', type: 'TEXT', nullable: true },
          { name: 'email', type: 'TEXT', nullable: true },
          { name: 'display_name', type: 'TEXT', nullable: false },
          { name: 'created_at', type: 'TEXT', nullable: true }
        ],
        indexes: [
          { name: 'idx_user_identities_discord_id', columns: ['discord_id'] },
          { name: 'idx_user_identities_email', columns: ['email'] }
        ]
      },
      {
        name: 'memories',
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'user_id', type: 'TEXT', nullable: false },
          { name: 'content', type: 'TEXT', nullable: false },
          { name: 'tags', type: 'TEXT', nullable: false, defaultValue: "'[]'" },
          { name: 'importance', type: 'INTEGER', nullable: true, defaultValue: '5' },
          { name: 'created_at', type: 'DATETIME', nullable: true }
        ],
        indexes: [
          { name: 'idx_memories_user_id', columns: ['user_id'] },
          { name: 'idx_memories_timestamp', columns: ['timestamp'] },
          { name: 'idx_memories_importance', columns: ['importance'] }
        ],
        foreignKeys: [
          { column: 'user_id', referencedTable: 'user_identities', referencedColumn: 'id' }
        ]
      },
      {
        name: 'messages',
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'user_id', type: 'TEXT', nullable: false },
          { name: 'value', type: 'TEXT', nullable: false },
          { name: 'created_at', type: 'TEXT', nullable: true }
        ],
        indexes: [
          { name: 'idx_messages_user_id', columns: ['user_id'] },
          { name: 'idx_messages_created_at', columns: ['created_at'] }
        ],
        foreignKeys: [
          { column: 'user_id', referencedTable: 'user_identities', referencedColumn: 'id' }
        ]
      },
      {
        name: 'prompts',
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'name', type: 'TEXT', nullable: false, unique: true },
          { name: 'content', type: 'TEXT', nullable: false },
          { name: 'version', type: 'INTEGER', nullable: false, defaultValue: '1' }
        ],
        indexes: [
          { name: 'idx_prompts_name_active', columns: ['name', 'is_active'] }
        ]
      }
      // Add other core tables as needed
    ];
  }
}