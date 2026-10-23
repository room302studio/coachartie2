/**
 * Structured output for "ask the model, read the answer" calls (wave 10, ledger Top-5 #2/#3).
 *
 * A caller describes the JSON it wants once (`JsonOutputSpec`). When the model catalog says the
 * model takes structured output, the request carries `response_format`; otherwise the prompt's
 * own "return JSON" instruction does the work. Either way the reply is read with
 * parseModelJson (shared/model-json.ts), so a model without structured output still works.
 *
 * Schemas follow OpenAI strict mode: an object at the root, every property listed in
 * `required`, `additionalProperties: false` (nullable fields use a ['string', 'null'] type).
 */
export interface JsonOutputSpec {
  /** Short identifier ([a-zA-Z0-9_-]), sent as json_schema.name. */
  name: string;
  schema: Record<string, unknown>;
}

/** What the catalog says the model accepts (model-catalog.ts structuredOutputMode). */
export type StructuredOutputMode = 'json_schema' | 'json_object';

export function responseFormatFor(spec: JsonOutputSpec, mode: StructuredOutputMode): Record<string, unknown> {
  return mode === 'json_schema'
    ? { type: 'json_schema', json_schema: { name: spec.name, strict: true, schema: spec.schema } }
    : { type: 'json_object' };
}
