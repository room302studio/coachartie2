#!/usr/bin/env node
// Query the metro-maker event pool using Node.js
// Usage: node query-events.js [preset|query]
//
// Examples:
//   node query-events.js
//   node query-events.js recent
//   node query-events.js types
//   node query-events.js "SELECT * WHERE type='click' LIMIT 50"

const { execSync } = require('child_process');

const ENDPOINT = 'https://catalog.cloudflarestorage.com/a5d6e80b1df831981a1d0ca249cf082e/subway-builder-warehouse';
const EVENT_TABLE = 'subway_builder_warehouse.logging.event_ingestion';
const EVENT_API_TOKEN = process.env.EVENT_API_TOKEN || 'placeholder';

// Preset queries
const PRESETS = {
  recent: `SELECT * FROM ${EVENT_TABLE} WHERE created_at > now() - interval 1 hour ORDER BY created_at DESC LIMIT 100`,
  types: `SELECT type, COUNT(*) as count FROM ${EVENT_TABLE} GROUP BY type ORDER BY count DESC`,
  summary: `SELECT DATE(created_at) as date, COUNT(*) as events FROM ${EVENT_TABLE} GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30`,
  hourly: `SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as events FROM ${EVENT_TABLE} WHERE created_at > now() - interval 24 hours GROUP BY hour ORDER BY hour DESC`,
  all: `SELECT * FROM ${EVENT_TABLE} ORDER BY created_at DESC LIMIT 100`,
};

const preset = process.argv[2] || 'all';
const query = PRESETS[preset] || preset;

const duckdbCommands = `
INSTALL iceberg; LOAD iceberg;
INSTALL httpfs; LOAD httpfs;
CREATE PERSISTENT SECRET subway_builder_warehouse (
    TYPE ICEBERG,
    TOKEN '${EVENT_API_TOKEN}'
);
ATTACH 'a5d6e80b1df831981a1d0ca249cf082e_subway-builder-warehouse' AS subway_builder_warehouse (
    READ_ONLY,
    TYPE ICEBERG,
    SECRET subway_builder_warehouse,
    ENDPOINT '${ENDPOINT}'
);
${query};
`;

try {
  const result = execSync(`duckdb :memory: -json`, {
    input: duckdbCommands,
    encoding: 'utf8',
  });

  // Parse and pretty print JSON
  const rows = JSON.parse(result);
  console.log(JSON.stringify(rows, null, 2));
} catch (error) {
  console.error('❌ Query failed:', error.message);
  console.error('\n💡 Available presets:', Object.keys(PRESETS).join(', '));
  process.exit(1);
}
