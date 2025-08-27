#!/usr/bin/env npx tsx
import { logger } from '@coachartie/shared';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import OpenAI from 'openai';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from root
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

// Debug: Check if API key is loaded
console.log('OPENROUTER_API_KEY loaded:', process.env.OPENROUTER_API_KEY ? 'Yes (length: ' + process.env.OPENROUTER_API_KEY.length + ')' : 'No');

const MODELS_TO_TEST = [
  'openai/gpt-oss-20b:free',
  'z-ai/glm-4.5-air:free',
  'qwen/qwen3-coder:free',
  'mistralai/mistral-7b-instruct:free',
  'microsoft/phi-3-mini-128k-instruct:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'google/gemma-2-9b-it:free',
  'moonshotai/kimi-k2:free',
  'nousresearch/hermes-3-llama-3.1-70b:free',
  'liquid/lfm-40b:free'
];

const TEST_CASES = [
  { input: "calculate 2 + 2", expected: 'calculator.*calculate.*expression="2\\+2"' },
  { input: "what is 10 divided by 5", expected: 'calculator.*calculate.*expression="10/5"' },
  { input: "add todo: fix bugs", expected: 'todo.*add.*expression="fix bugs"' }
];

// Our ultra-simple prompt
const SYSTEM_PROMPT = `CRITICAL: You MUST respond with ONLY an XML tag. NOTHING ELSE.

When user says "calculate 2+2" you write:
<capability name="calculator" action="calculate" expression="2+2" />

When user says "add todo: buy milk" you write:
<capability name="todo" action="add" expression="buy milk" />

PATTERN: <capability name="[tool]" action="[action]" expression="[content]" />

DO NOT write explanations. ONLY the XML tag.`;

async function testModel(modelName: string): Promise<{ model: string, results: boolean[], successRate: number }> {
  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    defaultHeaders: {
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'Coach Artie XML Test'
    }
  });

  const results: boolean[] = [];
  
  for (const testCase of TEST_CASES) {
    try {
      const response = await client.chat.completions.create({
        model: modelName,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: testCase.input }
        ],
        temperature: 0.1,
        max_tokens: 100
      });

      const content = response.choices[0]?.message?.content || '';
      const success = new RegExp(testCase.expected, 'i').test(content);
      results.push(success);
      
      if (success) {
        logger.info(`✅ ${modelName}: "${testCase.input}" → GENERATED XML!`);
        logger.info(`   Response: ${content.substring(0, 100)}`);
      } else {
        logger.info(`❌ ${modelName}: "${testCase.input}" → FAILED`);
        logger.info(`   Response: ${content.substring(0, 100)}`);
      }
      
      // Rate limit protection
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error: any) {
      logger.info(`⚠️ ${modelName}: Error - ${error.message}`);
      results.push(false);
    }
  }
  
  const successRate = (results.filter(r => r).length / results.length) * 100;
  return { model: modelName, results, successRate };
}

async function runScience() {
  logger.info('🔬 TESTING XML GENERATION ACROSS FREE MODELS 🔬');
  logger.info('================================================\n');
  
  const allResults: Array<{ model: string, successRate: number }> = [];
  
  for (const model of MODELS_TO_TEST) {
    logger.info(`\n📊 Testing: ${model}`);
    logger.info('-'.repeat(40));
    
    const result = await testModel(model);
    allResults.push({ model: result.model, successRate: result.successRate });
    
    logger.info(`📈 ${model} Success Rate: ${result.successRate.toFixed(0)}%\n`);
    
    // Longer delay between models
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Final report
  logger.info('\n🏆 FINAL RESULTS 🏆');
  logger.info('===================');
  
  // Sort by success rate
  allResults.sort((a, b) => b.successRate - a.successRate);
  
  for (const result of allResults) {
    const bar = '█'.repeat(Math.floor(result.successRate / 10));
    const spaces = '░'.repeat(10 - Math.floor(result.successRate / 10));
    logger.info(`${result.model.padEnd(40)} ${bar}${spaces} ${result.successRate.toFixed(0)}%`);
  }
  
  // Find winners
  const winners = allResults.filter(r => r.successRate > 0);
  if (winners.length > 0) {
    logger.info(`\n🎯 MODELS THAT WORK: ${winners.map(w => w.model).join(', ')}`);
  } else {
    logger.info('\n😭 NO MODELS SUCCESSFULLY GENERATED XML');
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runScience().then(() => {
    logger.info('\n✅ Test complete!');
    process.exit(0);
  }).catch(error => {
    logger.error('Test failed:', error);
    process.exit(1);
  });
}