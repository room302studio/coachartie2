// Test OpenRouter service directly
const { config } = require('dotenv');
const { resolve } = require('path');

// Load environment variables
config({ path: resolve('./packages/capabilities/.env') });

console.log('API Key exists:', process.env.OPENROUTER_API_KEY ? 'YES' : 'NO');
console.log('API Key starts with:', process.env.OPENROUTER_API_KEY?.substring(0, 10));

// Test basic fetch to OpenRouter
async function testOpenRouter() {
  try {
    console.log('Testing OpenRouter API...');
    
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://coach-artie.local',
        'X-Title': 'Coach Artie',
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ OpenRouter API accessible');
      console.log('Free models available:', data.data?.filter(m => m.pricing?.prompt === '0').length || 'unknown');
    } else {
      console.log('❌ OpenRouter API error:', response.status, response.statusText);
      const text = await response.text();
      console.log('Error details:', text);
    }
  } catch (error) {
    console.log('❌ Network error:', error.message);
  }
}

testOpenRouter();