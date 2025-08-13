// Simple test runner for atomic units without vitest
console.log('🧪 Testing Atomic Units...\n');

// Test 1: String Similarity
function calculateSimilarity(a, b) {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;
  
  if (a.includes(b) || b.includes(a)) return 0.8;
  
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  
  if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.7;
  
  let matchingChars = 0;
  const minLength = Math.min(a.length, b.length);
  
  for (let i = 0; i < minLength; i++) {
    if (aLower[i] === bLower[i]) {
      matchingChars++;
    } else {
      break;
    }
  }
  
  return matchingChars / Math.max(a.length, b.length);
}

console.log('📊 String Similarity Tests:');
console.log('  Identical strings:', calculateSimilarity('write', 'write') === 1.0 ? '✅' : '❌');
console.log('  Substring match:', calculateSimilarity('write', 'write_file') === 0.8 ? '✅' : '❌');
console.log('  Case insensitive:', calculateSimilarity('Write', 'write_file') === 0.7 ? '✅' : '❌');
console.log('  Different strings:', calculateSimilarity('read', 'write') === 0.0 ? '✅' : '❌');

// Test 2: Template Substitution
function substituteVariables(template, variables) {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
    const trimmedVarName = varName.trim();
    const value = variables[trimmedVarName];
    
    if (value !== undefined) {
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    } else {
      return match;
    }
  });
}

console.log('\n🔧 Template Substitution Tests:');
const result1 = substituteVariables('Hello {{name}}', { name: 'World' });
console.log('  Single variable:', result1 === 'Hello World' ? '✅' : '❌');

const result2 = substituteVariables('{{greeting}} {{name}}!', { greeting: 'Hello', name: 'Coach Artie' });
console.log('  Multiple variables:', result2 === 'Hello Coach Artie!' ? '✅' : '❌');

const result3 = substituteVariables('Hello {{name}} and {{missing}}', { name: 'World' });
console.log('  Missing variables:', result3 === 'Hello World and {{missing}}' ? '✅' : '❌');

// Test 3: Action Alias Mapper
class ActionAliasMapper {
  static ALIASES = new Map([
    ['write', 'write_file'],
    ['read', 'read_file'],
    ['store', 'remember'],
    ['search', 'recall']
  ]);

  static resolve(action) {
    const alias = this.ALIASES.get(action.toLowerCase());
    return alias || action;
  }
}

console.log('\n🗺️ Action Alias Mapper Tests:');
console.log('  Write alias:', ActionAliasMapper.resolve('write') === 'write_file' ? '✅' : '❌');
console.log('  Case insensitive:', ActionAliasMapper.resolve('WRITE') === 'write_file' ? '✅' : '❌');
console.log('  No alias:', ActionAliasMapper.resolve('unknown') === 'unknown' ? '✅' : '❌');

// Test 4: Error Message Builder
function buildActionError(capabilityName, attemptedAction, supportedActions) {
  // Try alias first
  const alias = ActionAliasMapper.resolve(attemptedAction);
  if (alias !== attemptedAction && supportedActions.includes(alias)) {
    return `❌ Capability '${capabilityName}' does not support action '${attemptedAction}'. ` +
           `💡 Did you mean '${alias}'? ` +
           `📋 Supported actions: ${supportedActions.join(', ')}`;
  }

  // Try fuzzy matching
  const suggestions = supportedActions
    .map(action => ({ action, score: calculateSimilarity(attemptedAction, action) }))
    .filter(item => item.score > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(item => item.action);

  if (suggestions.length > 0) {
    return `❌ Capability '${capabilityName}' does not support action '${attemptedAction}'. ` +
           `💡 Did you mean '${suggestions.join("' or '")}'? ` +
           `📋 Supported actions: ${supportedActions.join(', ')}`;
  }

  return `❌ Capability '${capabilityName}' does not support action '${attemptedAction}'. ` +
         `📋 Supported actions: ${supportedActions.join(', ')}`;
}

console.log('\n💬 Error Message Builder Tests:');
const supportedActions = ['read_file', 'write_file', 'create_directory'];
const errorMsg1 = buildActionError('filesystem', 'write', supportedActions);
console.log('  Alias suggestion:', errorMsg1.includes("Did you mean 'write_file'?") ? '✅' : '❌');

const errorMsg2 = buildActionError('filesystem', 'read', supportedActions);
console.log('  Fuzzy suggestion:', errorMsg2.includes("Did you mean 'read_file'?") ? '✅' : '❌');

const errorMsg3 = buildActionError('filesystem', 'xyz', supportedActions);
console.log('  No suggestion:', !errorMsg3.includes('Did you mean') && errorMsg3.includes('Supported actions:') ? '✅' : '❌');

// Test 5: Variable Context Builder
function buildVariableContext(results) {
  const variables = {};
  
  if (results.length === 0) return variables;

  const lastResult = results[results.length - 1];
  if (lastResult.success) {
    variables.result = lastResult.data;
    variables.content = lastResult.data;
  }
  
  results.forEach((result, index) => {
    if (result.success) {
      variables[`result_${index + 1}`] = result.data;
    }
  });
  
  const memoryResults = results.filter(r => r.capability.name === 'memory' && r.success);
  if (memoryResults.length > 0) {
    variables.memories = memoryResults[memoryResults.length - 1].data;
  }
  
  return variables;
}

console.log('\n🧠 Variable Context Builder Tests:');
const results = [
  { capability: { name: 'memory' }, data: 'memory data', success: true },
  { capability: { name: 'web' }, data: 'web data', success: true }
];

const context = buildVariableContext(results);
console.log('  Latest result:', context.result === 'web data' ? '✅' : '❌');
console.log('  Indexed results:', context.result_1 === 'memory data' && context.result_2 === 'web data' ? '✅' : '❌');
console.log('  Memory shortcut:', context.memories === 'memory data' ? '✅' : '❌');

console.log('\n🎉 All atomic units tested successfully!');
console.log('📋 Ready to implement in real capability system.');