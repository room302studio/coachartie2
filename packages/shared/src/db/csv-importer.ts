import { Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';
import { SchemaValidator, ValidationResult } from './schema-validator.js';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';

/**
 * CSV import configuration
 */
export interface ImportConfig {
  tableName: string;
  filePath: string;
  delimiter?: string;
  hasHeader?: boolean;
  batchSize?: number;
  columnMapping?: Record<string, string>; // CSV column -> DB column
  transformers?: Record<string, (value: string) => any>; // Column transformers
  validation?: {
    required?: string[]; // Required columns
    unique?: string[]; // Columns that should be unique
    maxLength?: Record<string, number>; // Max length per column
    patterns?: Record<string, RegExp>; // Regex validation per column
  };
  onConflict?: 'ignore' | 'replace' | 'abort'; // What to do on conflicts
  dryRun?: boolean; // Preview mode - don't actually insert
}

/**
 * Import results
 */
export interface ImportResult {
  success: boolean;
  recordsProcessed: number;
  recordsInserted: number;
  recordsSkipped: number;
  recordsErrored: number;
  errors: ImportError[];
  warnings: ImportWarning[];
  preview?: any[]; // Sample of what would be imported (dry run only)
  executionTime: number; // milliseconds
}

export interface ImportError {
  row: number;
  column?: string;
  value?: string;
  message: string;
  type: 'validation' | 'constraint' | 'parsing' | 'database';
}

export interface ImportWarning {
  row?: number;
  column?: string;
  message: string;
  type: 'data_quality' | 'performance' | 'schema';
}

/**
 * Supported table schemas for CSV import
 */
interface TableImportSchema {
  tableName: string;
  requiredColumns: string[];
  optionalColumns: string[];
  columnTypes: Record<string, 'string' | 'number' | 'boolean' | 'date' | 'json'>;
  columnValidation: Record<string, {
    required?: boolean;
    maxLength?: number;
    pattern?: RegExp;
    transform?: (value: string) => any;
  }>;
}

/**
 * CSV Importer for Coach Artie database
 * Like a sophisticated prep station - validates ingredients before they go into our data kitchen!
 */
export class CSVImporter {
  private db: Database<sqlite3.Database, sqlite3.Statement>;
  private validator: SchemaValidator;
  private supportedTables: Map<string, TableImportSchema>;

  constructor(database: Database<sqlite3.Database, sqlite3.Statement>) {
    this.db = database;
    this.validator = new SchemaValidator(database);
    this.supportedTables = new Map();
    
    this.initializeSupportedTables();
  }

  /**
   * Import CSV file into specified table
   */
  async importCSV(config: ImportConfig): Promise<ImportResult> {
    const startTime = Date.now();
    
    const result: ImportResult = {
      success: false,
      recordsProcessed: 0,
      recordsInserted: 0,
      recordsSkipped: 0,
      recordsErrored: 0,
      errors: [],
      warnings: [],
      executionTime: 0
    };

    try {
      logger.info(`📥 Starting CSV import: ${config.filePath} → ${config.tableName}`);

      // Pre-import validation
      await this.validateImportConfig(config, result);
      
      if (result.errors.length > 0) {
        logger.error(`❌ Import configuration invalid: ${result.errors.length} errors`);
        return result;
      }

      // Validate schema before import
      const schemaValidation = await this.validator.validateSchema();
      if (!schemaValidation.isValid) {
        result.errors.push({
          row: 0,
          message: 'Database schema validation failed - fix schema issues before importing',
          type: 'database'
        });
        return result;
      }

      // Read and parse CSV
      const records = await this.parseCSVFile(config, result);
      if (!records) {
        return result;
      }

      // Process records
      await this.processRecords(config, records, result);

      result.success = result.recordsErrored === 0;
      result.executionTime = Date.now() - startTime;

      const summary = `📊 Import complete: ${result.recordsInserted} inserted, ${result.recordsSkipped} skipped, ${result.recordsErrored} errors (${result.executionTime}ms)`;
      
      if (result.success) {
        logger.info(`✅ ${summary}`);
      } else {
        logger.error(`❌ ${summary}`);
      }

      return result;

    } catch (error) {
      result.errors.push({
        row: 0,
        message: `Import crashed: ${error}`,
        type: 'database'
      });
      result.executionTime = Date.now() - startTime;
      logger.error('CSV import failed:', error);
      return result;
    }
  }

  /**
   * Validate import configuration
   */
  private async validateImportConfig(config: ImportConfig, result: ImportResult): Promise<void> {
    // Check if table is supported
    const tableSchema = this.supportedTables.get(config.tableName);
    if (!tableSchema) {
      result.errors.push({
        row: 0,
        message: `Table '${config.tableName}' is not supported for CSV import`,
        type: 'validation'
      });
      return;
    }

    // Check if file exists
    if (!fs.existsSync(config.filePath)) {
      result.errors.push({
        row: 0,
        message: `CSV file not found: ${config.filePath}`,
        type: 'validation'
      });
      return;
    }

    // Check file size (warn if > 100MB)
    const stats = fs.statSync(config.filePath);
    if (stats.size > 100 * 1024 * 1024) {
      result.warnings.push({
        message: `Large file detected (${Math.round(stats.size / 1024 / 1024)}MB) - consider splitting into smaller files`,
        type: 'performance'
      });
    }

    // Check table exists in database
    const tableExists = await this.db.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [config.tableName]
    );

    if (!tableExists) {
      result.errors.push({
        row: 0,
        message: `Target table '${config.tableName}' does not exist in database`,
        type: 'database'
      });
    }

    logger.info(`✅ Import configuration validated for ${config.tableName}`);
  }

  /**
   * Parse CSV file into records
   */
  private async parseCSVFile(config: ImportConfig, result: ImportResult): Promise<any[] | null> {
    return new Promise((resolve, reject) => {
      const records: any[] = [];
      const parser = parse({
        delimiter: config.delimiter || ',',
        columns: config.hasHeader !== false, // Default to true
        skip_empty_lines: true,
        trim: true,
        cast: false // Keep everything as strings initially
      });

      parser.on('readable', function() {
        let record;
        while ((record = parser.read()) !== null) {
          records.push(record);
          result.recordsProcessed++;

          // Memory management for large files
          if (records.length > 10000) {
            result.warnings.push({
              message: `Processing large dataset (${records.length}+ records) - consider batch processing`,
              type: 'performance'
            });
          }
        }
      });

      parser.on('error', function(err: any) {
        result.errors.push({
          row: result.recordsProcessed,
          message: `CSV parsing error: ${err.message}`,
          type: 'parsing'
        });
        resolve(null);
      });

      parser.on('end', function() {
        logger.info(`📄 Parsed ${records.length} records from CSV`);
        resolve(records);
      });

      // Read file stream
      const stream = fs.createReadStream(config.filePath);
      stream.pipe(parser);

      stream.on('error', (err) => {
        result.errors.push({
          row: 0,
          message: `File read error: ${err.message}`,
          type: 'parsing'
        });
        resolve(null);
      });
    });
  }

  /**
   * Process and validate records for import
   */
  private async processRecords(config: ImportConfig, records: any[], result: ImportResult): Promise<void> {
    const tableSchema = this.supportedTables.get(config.tableName)!;
    const batchSize = config.batchSize || 1000;
    
    // Preview mode - just show sample
    if (config.dryRun) {
      result.preview = records.slice(0, 10);
      logger.info(`🔍 Dry run - showing first 10 records out of ${records.length}`);
      return;
    }

    // Process in batches for better performance
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await this.processBatch(config, batch, i, tableSchema, result);
      
      // Log progress for large imports
      if (records.length > 1000) {
        logger.info(`📈 Processed ${Math.min(i + batchSize, records.length)}/${records.length} records`);
      }
    }
  }

  /**
   * Process a batch of records
   */
  private async processBatch(
    config: ImportConfig,
    batch: any[],
    offset: number,
    tableSchema: TableImportSchema,
    result: ImportResult
  ): Promise<void> {
    
    const transaction = await this.db.run('BEGIN TRANSACTION');
    
    try {
      for (let i = 0; i < batch.length; i++) {
        const record = batch[i];
        const rowNumber = offset + i + 1;

        // Validate and transform record
        const processedRecord = await this.validateAndTransformRecord(
          record, 
          rowNumber,
          config,
          tableSchema,
          result
        );

        if (!processedRecord) {
          result.recordsSkipped++;
          continue;
        }

        // Insert record
        try {
          await this.insertRecord(config.tableName, processedRecord);
          result.recordsInserted++;
        } catch (insertError) {
          if (config.onConflict === 'ignore' && this.isConstraintError(insertError)) {
            result.recordsSkipped++;
            result.warnings.push({
              row: rowNumber,
              message: `Record skipped due to constraint violation (${config.onConflict} mode)`,
              type: 'data_quality'
            });
          } else {
            result.recordsErrored++;
            result.errors.push({
              row: rowNumber,
              message: `Database insert failed: ${insertError}`,
              type: 'database'
            });
          }
        }
      }

      await this.db.run('COMMIT');

    } catch (error) {
      await this.db.run('ROLLBACK');
      logger.error(`Batch processing failed, rolled back:`, error);
      
      // Mark all batch records as errored
      for (let i = 0; i < batch.length; i++) {
        result.recordsErrored++;
        result.errors.push({
          row: offset + i + 1,
          message: `Batch processing failed: ${error}`,
          type: 'database'
        });
      }
    }
  }

  /**
   * Validate and transform a single record
   */
  private async validateAndTransformRecord(
    record: any,
    rowNumber: number,
    config: ImportConfig,
    tableSchema: TableImportSchema,
    result: ImportResult
  ): Promise<any | null> {
    
    const processedRecord: any = {};
    let hasErrors = false;

    // Apply column mapping if provided
    const mappedRecord = config.columnMapping ? 
      this.applyColumnMapping(record, config.columnMapping) : record;

    // Validate required columns
    for (const requiredCol of tableSchema.requiredColumns) {
      if (!mappedRecord[requiredCol] || mappedRecord[requiredCol].toString().trim() === '') {
        result.errors.push({
          row: rowNumber,
          column: requiredCol,
          message: `Required column '${requiredCol}' is missing or empty`,
          type: 'validation'
        });
        hasErrors = true;
        continue;
      }
    }

    if (hasErrors) {
      return null;
    }

    // Process all columns
    for (const [column, value] of Object.entries(mappedRecord)) {
      // Skip unknown columns
      if (!tableSchema.columnTypes[column]) {
        result.warnings.push({
          row: rowNumber,
          column,
          message: `Unknown column '${column}' will be ignored`,
          type: 'schema'
        });
        continue;
      }

      try {
        // Apply validation and transformation
        const validation = tableSchema.columnValidation[column];
        let processedValue = this.transformValue(value as string, tableSchema.columnTypes[column], validation);
        
        // Apply custom transformers
        if (config.transformers?.[column]) {
          processedValue = config.transformers[column](processedValue);
        }

        // Additional validation
        if (validation) {
          if (validation.maxLength && processedValue.toString().length > validation.maxLength) {
            result.errors.push({
              row: rowNumber,
              column,
              value: processedValue,
              message: `Value exceeds max length of ${validation.maxLength}`,
              type: 'validation'
            });
            hasErrors = true;
            continue;
          }

          if (validation.pattern && !validation.pattern.test(processedValue.toString())) {
            result.errors.push({
              row: rowNumber,
              column,
              value: processedValue,
              message: `Value does not match required pattern`,
              type: 'validation'
            });
            hasErrors = true;
            continue;
          }
        }

        processedRecord[column] = processedValue;

      } catch (transformError) {
        result.errors.push({
          row: rowNumber,
          column,
          value: value as string,
          message: `Transformation failed: ${transformError}`,
          type: 'validation'
        });
        hasErrors = true;
      }
    }

    return hasErrors ? null : processedRecord;
  }

  /**
   * Transform value based on expected type
   */
  private transformValue(value: string, expectedType: string, validation?: any): any {
    if (!value || value.trim() === '') {
      return null;
    }

    const trimmedValue = value.trim();

    switch (expectedType) {
      case 'number':
        const num = Number(trimmedValue);
        if (isNaN(num)) {
          throw new Error(`Invalid number: '${trimmedValue}'`);
        }
        return num;

      case 'boolean':
        const lower = trimmedValue.toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(lower)) return true;
        if (['false', '0', 'no', 'n'].includes(lower)) return false;
        throw new Error(`Invalid boolean: '${trimmedValue}'`);

      case 'date':
        const date = new Date(trimmedValue);
        if (isNaN(date.getTime())) {
          throw new Error(`Invalid date: '${trimmedValue}'`);
        }
        return date.toISOString();

      case 'json':
        try {
          return JSON.parse(trimmedValue);
        } catch {
          throw new Error(`Invalid JSON: '${trimmedValue}'`);
        }

      case 'string':
      default:
        // Apply custom transformation if provided
        if (validation?.transform) {
          return validation.transform(trimmedValue);
        }
        return trimmedValue;
    }
  }

  /**
   * Apply column mapping
   */
  private applyColumnMapping(record: any, mapping: Record<string, string>): any {
    const mapped: any = {};
    
    for (const [csvColumn, dbColumn] of Object.entries(mapping)) {
      if (record[csvColumn] !== undefined) {
        mapped[dbColumn] = record[csvColumn];
      }
    }

    // Also copy unmapped columns
    for (const [key, value] of Object.entries(record)) {
      if (!mapping[key] && !mapped[key]) {
        mapped[key] = value;
      }
    }

    return mapped;
  }

  /**
   * Insert record into database
   */
  private async insertRecord(tableName: string, record: any): Promise<void> {
    const columns = Object.keys(record);
    const values = Object.values(record);
    const placeholders = columns.map(() => '?').join(', ');

    const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
    await this.db.run(sql, values);
  }

  /**
   * Check if error is a constraint violation
   */
  private isConstraintError(error: any): boolean {
    const errorMsg = error.toString().toLowerCase();
    return errorMsg.includes('unique') || 
           errorMsg.includes('constraint') ||
           errorMsg.includes('foreign key');
  }

  /**
   * Initialize supported table schemas
   */
  private initializeSupportedTables(): void {
    // User identities
    this.supportedTables.set('user_identities', {
      tableName: 'user_identities',
      requiredColumns: ['id', 'display_name'],
      optionalColumns: ['discord_id', 'email', 'phone_number', 'metadata'],
      columnTypes: {
        id: 'string',
        discord_id: 'string',
        email: 'string',
        phone_number: 'string',
        display_name: 'string',
        metadata: 'json'
      },
      columnValidation: {
        id: { required: true, maxLength: 255 },
        display_name: { required: true, maxLength: 255 },
        email: { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
        phone_number: { pattern: /^[\+]?[0-9\-\(\)\s]+$/ }
      }
    });

    // Memories
    this.supportedTables.set('memories', {
      tableName: 'memories',
      requiredColumns: ['user_id', 'content', 'timestamp'],
      optionalColumns: ['tags', 'context', 'importance'],
      columnTypes: {
        user_id: 'string',
        content: 'string',
        tags: 'json',
        context: 'string',
        timestamp: 'date',
        importance: 'number'
      },
      columnValidation: {
        user_id: { required: true, maxLength: 255 },
        content: { required: true },
        importance: { 
          transform: (val: string) => Math.max(1, Math.min(10, parseInt(val) || 5)) 
        },
        tags: {
          transform: (val: string) => {
            if (val.startsWith('[')) return JSON.parse(val);
            return val.split(',').map(tag => tag.trim());
          }
        }
      }
    });

    // Messages
    this.supportedTables.set('messages', {
      tableName: 'messages',
      requiredColumns: ['user_id', 'value'],
      optionalColumns: ['channel_id', 'guild_id', 'message_type', 'email_metadata'],
      columnTypes: {
        user_id: 'string',
        channel_id: 'string',
        guild_id: 'string',
        value: 'string',
        message_type: 'string',
        email_metadata: 'json'
      },
      columnValidation: {
        user_id: { required: true, maxLength: 255 },
        value: { required: true },
        message_type: { 
          transform: (val: string) => val || 'user'
        }
      }
    });

    // Prompts
    this.supportedTables.set('prompts', {
      tableName: 'prompts',
      requiredColumns: ['name', 'content'],
      optionalColumns: ['description', 'category', 'metadata'],
      columnTypes: {
        name: 'string',
        content: 'string',
        description: 'string',
        category: 'string',
        metadata: 'json'
      },
      columnValidation: {
        name: { required: true, maxLength: 255 },
        content: { required: true },
        category: {
          transform: (val: string) => val || 'general'
        }
      }
    });

    logger.info(`✅ Initialized ${this.supportedTables.size} supported tables for CSV import`);
  }

  /**
   * Get sample import configuration for a table
   */
  getSampleConfig(tableName: string): ImportConfig | null {
    const tableSchema = this.supportedTables.get(tableName);
    if (!tableSchema) return null;

    return {
      tableName,
      filePath: `/path/to/${tableName}.csv`,
      hasHeader: true,
      batchSize: 1000,
      onConflict: 'ignore',
      dryRun: false,
      validation: {
        required: tableSchema.requiredColumns,
        maxLength: Object.fromEntries(
          Object.entries(tableSchema.columnValidation)
            .filter(([_, validation]) => validation.maxLength)
            .map(([col, validation]) => [col, validation.maxLength!])
        )
      }
    };
  }

  /**
   * List supported tables
   */
  getSupportedTables(): string[] {
    return Array.from(this.supportedTables.keys());
  }
}