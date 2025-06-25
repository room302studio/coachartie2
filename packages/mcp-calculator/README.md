# MCP Calculator Server

A Model Context Protocol (MCP) server providing mathematical calculation capabilities for AI assistants.

## Features

- **Basic Calculations**: Arithmetic, trigonometry, logarithms, and more
- **Advanced Calculations**: Custom precision and output formatting
- **Statistics**: Mean, median, mode, standard deviation, variance, min, max, sum
- **Unit Conversions**: Convert between different units of measurement

## Installation

```bash
pnpm install
pnpm build
```

## Usage

### As a standalone server

```bash
pnpm start
```

### As a development server with auto-reload

```bash
pnpm dev
```

### With debugging

```bash
pnpm inspector
```

## Tools Available

### `calculate`
Perform basic mathematical calculations.

**Parameters:**
- `expression` (string): Mathematical expression to evaluate

**Example:**
```json
{
  "expression": "2 + 3 * 4"
}
```

### `advanced_calculate`
Advanced calculations with custom precision and formatting.

**Parameters:**
- `expression` (string): Mathematical expression to evaluate
- `precision` (number, optional): Number of significant digits (1-64)
- `format` (string, optional): Output format ("number", "fraction", "exponential")

### `statistics`
Calculate statistical measures for a dataset.

**Parameters:**
- `numbers` (array): Array of numbers to analyze
- `operation` (string): Statistical operation ("mean", "median", "mode", "std", "variance", "min", "max", "sum")

### `convert_units`
Convert between different units of measurement.

**Parameters:**
- `value` (number): Numeric value to convert
- `fromUnit` (string): Source unit
- `toUnit` (string): Target unit

## Development

This package is part of the Coach Artie monorepo and follows the established patterns for TypeScript ES modules.

### Project Structure

```
src/
├── index.ts      # Main server entry point
└── tools.ts      # Tool definitions and execution functions
```

### Building

```bash
pnpm build
```

### Type Checking

```bash
pnpm typecheck
```

## Dependencies

- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `mathjs`: Mathematical expression evaluator
- `zod`: Runtime type validation