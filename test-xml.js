import { CapabilityXMLParser } from './packages/capabilities/src/utils/xml-parser.js';

const parser = new CapabilityXMLParser();
const testXml = '<capability name="mcp_client" action="call_tool" tool_name="search_wikipedia" args="{\\"query\\": \\"dogs\\"}">Search dogs</capability>';

console.log('Input XML:', testXml);
const result = parser.extractCapabilities(testXml);
console.log('Parsed result:', JSON.stringify(result, null, 2));