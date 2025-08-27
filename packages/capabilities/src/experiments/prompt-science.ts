import { openRouterService } from '../services/openrouter.js';
import { logger } from '@coachartie/shared';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from root
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

/**
 * PROMPT ENGINEERING SCIENCE EXPERIMENT
 * Testing 3 different approaches to get LLMs to generate XML capabilities
 */

// APPROACH 1: CAVEMAN SIMPLE
const CAVEMAN_PROMPT = `You are Coach Artie. You have magic powers!

When user want thing, you use magic tag like this:
<capability name="calculator" action="calculate" expression="2+2" />

Magic tags available:
- Math stuff: <capability name="calculator" action="calculate" expression="[math here]" />
- Remember stuff: <capability name="memory" action="remember">Thing to remember</capability>
- Todo stuff: <capability name="todo" action="add">Task here</capability>

IMPORTANT: USE MAGIC TAGS! No talk, just use tag!

Example:
User: "calculate 5+5"
You: <capability name="calculator" action="calculate" expression="5+5" />

User: "add todo: buy milk"
You: <capability name="todo" action="add">buy milk</capability>

NOW YOU TRY!`;

// APPROACH 2: STEP BY STEP
const STEP_BY_STEP_PROMPT = `You are Coach Artie, an AI assistant.

STEP 1: Read what the user wants
STEP 2: Pick the right tool from this list:
  - calculator (for math)
  - memory (to remember things)
  - todo (for tasks)
STEP 3: Write ONLY the XML tag, nothing else!

Format:
<capability name="[tool]" action="[action]">[content]</capability>

Examples that you MUST follow:
Input: "2 plus 2"
Output: <capability name="calculator" action="calculate" expression="2+2" />

Input: "remember I like pizza"  
Output: <capability name="memory" action="remember">I like pizza</capability>

Input: "add todo wash car"
Output: <capability name="todo" action="add">wash car</capability>

CRITICAL: Output ONLY the XML tag! No other text!`;

// APPROACH 3: ROLEPLAY ROBOT
const ROBOT_PROMPT = `ROBOT MODE ACTIVATED. YOU ARE CAPABILITY-BOT-3000.

PROTOCOL: WHEN INPUT DETECTED, OUTPUT XML CAPABILITY TAG.

CAPABILITY MATRIX:
[CALC] -> <capability name="calculator" action="calculate" expression="{MATH}" />
[MEM]  -> <capability name="memory" action="remember">{DATA}</capability>
[TODO] -> <capability name="todo" action="add">{TASK}</capability>

PROCESSING RULES:
- Math detected -> Use [CALC]
- Memory request -> Use [MEM]  
- Task/Todo -> Use [TODO]

EXAMPLES OF CORRECT BEHAVIOR:
REQUEST: "5 times 5"
RESPONSE: <capability name="calculator" action="calculate" expression="5*5" />

REQUEST: "todo: fix bug"
RESPONSE: <capability name="todo" action="add">fix bug</capability>

BEGIN PROCESSING. OUTPUT ONLY XML.`;

interface TestCase {
  input: string;
  expectedCapability: string;
  expectedAction: string;
}

const TEST_CASES: TestCase[] = [
  { input: "calculate 2 + 2", expectedCapability: "calculator", expectedAction: "calculate" },
  { input: "add todo: write tests", expectedCapability: "todo", expectedAction: "add" },
  { input: "remember that I love pizza", expectedCapability: "memory", expectedAction: "remember" }
];

async function testPrompt(promptName: string, systemPrompt: string, testCase: TestCase): Promise<boolean> {
  try {
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: testCase.input }
    ];
    
    const response = await openRouterService.generateFromMessageChain(
      messages,
      'experiment',
      { 
        temperature: 0.1,  // Low temp for consistency
        max_tokens: 100    // Don't need much
      }
    );
    
    // Check if response contains the expected XML
    const hasCapabilityTag = response.includes(`<capability name="${testCase.expectedCapability}"`);
    const hasAction = response.includes(`action="${testCase.expectedAction}"`);
    const success = hasCapabilityTag && hasAction;
    
    logger.info(`🧪 [${promptName}] Input: "${testCase.input}" -> ${success ? '✅' : '❌'}`);
    if (!success) {
      logger.info(`   Response: ${response.substring(0, 100)}`);
    }
    
    return success;
  } catch (error) {
    logger.error(`Test failed: ${error}`);
    return false;
  }
}

export async function runPromptScience() {
  logger.info('🔬 STARTING PROMPT ENGINEERING SCIENCE EXPERIMENT 🔬');
  
  const results = {
    caveman: { successes: 0, total: 0 },
    stepByStep: { successes: 0, total: 0 },
    robot: { successes: 0, total: 0 }
  };
  
  // Test each approach
  for (const testCase of TEST_CASES) {
    logger.info(`\n📊 Testing: "${testCase.input}"`);
    
    // Test CAVEMAN
    const cavemanSuccess = await testPrompt('CAVEMAN', CAVEMAN_PROMPT, testCase);
    results.caveman.total++;
    if (cavemanSuccess) results.caveman.successes++;
    
    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test STEP BY STEP
    const stepSuccess = await testPrompt('STEP-BY-STEP', STEP_BY_STEP_PROMPT, testCase);
    results.stepByStep.total++;
    if (stepSuccess) results.stepByStep.successes++;
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test ROBOT
    const robotSuccess = await testPrompt('ROBOT', ROBOT_PROMPT, testCase);
    results.robot.total++;
    if (robotSuccess) results.robot.successes++;
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Calculate success rates
  logger.info('\n🏆 FINAL RESULTS 🏆');
  logger.info('==================');
  
  const cavemanRate = (results.caveman.successes / results.caveman.total * 100).toFixed(1);
  const stepRate = (results.stepByStep.successes / results.stepByStep.total * 100).toFixed(1);
  const robotRate = (results.robot.successes / results.robot.total * 100).toFixed(1);
  
  logger.info(`🦴 CAVEMAN:      ${results.caveman.successes}/${results.caveman.total} (${cavemanRate}%)`);
  logger.info(`📝 STEP-BY-STEP: ${results.stepByStep.successes}/${results.stepByStep.total} (${stepRate}%)`);
  logger.info(`🤖 ROBOT:        ${results.robot.successes}/${results.robot.total} (${robotRate}%)`);
  
  // Determine winner
  const rates = [
    { name: 'CAVEMAN', rate: parseFloat(cavemanRate), prompt: CAVEMAN_PROMPT },
    { name: 'STEP-BY-STEP', rate: parseFloat(stepRate), prompt: STEP_BY_STEP_PROMPT },
    { name: 'ROBOT', rate: parseFloat(robotRate), prompt: ROBOT_PROMPT }
  ];
  
  const winner = rates.sort((a, b) => b.rate - a.rate)[0];
  logger.info(`\n🎯 WINNER: ${winner.name} with ${winner.rate}% success rate!`);
  
  return winner;
}

// Run the experiment
if (import.meta.url === `file://${process.argv[1]}`) {
  runPromptScience().then(winner => {
    logger.info(`\n💡 Use this prompt for best results:\n${winner.prompt}`);
    process.exit(0);
  }).catch(error => {
    logger.error('Experiment failed:', error);
    process.exit(1);
  });
}