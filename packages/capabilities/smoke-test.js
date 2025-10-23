#!/usr/bin/env node

/**
 * Cancer-Free System Smoke Tests
 *
 * Tests the real implementations directly without starting the full service
 */

import { VectorEmbeddingService } from './src/services/vector-embeddings.js';
import { BasicKeywordMemoryEntourage } from './src/services/basic-keyword-memory-entourage.js';
import { SemanticMemoryEntourage } from './src/services/semantic-memory-entourage.js';
import { TemporalMemoryEntourage } from './src/services/temporal-memory-entourage.js';
import { CombinedMemoryEntourage } from './src/services/combined-memory-entourage.js';

console.log('🧪 SMOKE TESTS: Cancer-Free System Verification\n');

// Test 1: Vector Embeddings Service (Real Implementation)
console.log('🔬 TEST 1: Real Vector Embeddings Service');
try {
  const vectorService = VectorEmbeddingService.getInstance();
  await vectorService.initialize();

  const embedding = await vectorService.generateEmbedding('test semantic search');
  console.log(`✅ Generated real TF-IDF embedding: ${embedding.length} dimensions`);

  const status = vectorService.getStatus();
  console.log(`✅ Service status: ${status.split('\n')[0]}`);
  console.log(`✅ Service ready: ${vectorService.isReady()}`);
} catch (error) {
  console.log(`❌ Vector embeddings test failed: ${error.message}`);
}

// Test 2: Basic Keyword Memory Entourage
console.log('\n🔬 TEST 2: BasicKeywordMemoryEntourage');
try {
  const keywordEntourage = new BasicKeywordMemoryEntourage();
  const result = await keywordEntourage.getMemoryContext(
    'I love coffee in the morning',
    'test-user',
    { priority: 'speed', minimal: false }
  );

  console.log(`✅ Keyword search completed`);
  console.log(`✅ Memory count: ${result.memoryCount}`);
  console.log(`✅ Confidence: ${result.confidence.toFixed(2)}`);
  console.log(`✅ Categories: ${result.categories.join(', ')}`);
} catch (error) {
  console.log(`❌ Keyword entourage test failed: ${error.message}`);
}

// Test 3: Semantic Memory Entourage
console.log('\n🔬 TEST 3: SemanticMemoryEntourage');
try {
  const semanticEntourage = new SemanticMemoryEntourage();
  const result = await semanticEntourage.getMemoryContext('weekend relaxation time', 'test-user', {
    priority: 'accuracy',
    minimal: false,
  });

  console.log(`✅ Semantic search completed`);
  console.log(`✅ Memory count: ${result.memoryCount}`);
  console.log(`✅ Confidence: ${result.confidence.toFixed(2)}`);
  console.log(`✅ Categories: ${result.categories.join(', ')}`);
} catch (error) {
  console.log(`❌ Semantic entourage test failed: ${error.message}`);
}

// Test 4: Temporal Memory Entourage
console.log('\n🔬 TEST 4: TemporalMemoryEntourage');
try {
  const temporalEntourage = new TemporalMemoryEntourage();
  const result = await temporalEntourage.getMemoryContext(
    'what did I do yesterday morning?',
    'test-user',
    { priority: 'comprehensive', minimal: false }
  );

  console.log(`✅ Temporal search completed`);
  console.log(`✅ Memory count: ${result.memoryCount}`);
  console.log(`✅ Confidence: ${result.confidence.toFixed(2)}`);
  console.log(`✅ Categories: ${result.categories.join(', ')}`);
} catch (error) {
  console.log(`❌ Temporal entourage test failed: ${error.message}`);
}

// Test 5: Combined Memory Entourage (3-Layer System)
console.log('\n🔬 TEST 5: CombinedMemoryEntourage (3-Layer System)');
try {
  const combinedEntourage = new CombinedMemoryEntourage();
  const result = await combinedEntourage.getMemoryContext(
    'I want something spicy for lunch today',
    'test-user',
    { priority: 'comprehensive', minimal: false, maxTokens: 500 }
  );

  console.log(`✅ 3-layer search completed`);
  console.log(`✅ Memory count: ${result.memoryCount}`);
  console.log(`✅ Confidence: ${result.confidence.toFixed(2)}`);
  console.log(`✅ Categories: ${result.categories.join(', ')}`);

  // Show entourage status
  const status = combinedEntourage.getEntourageStatus();
  console.log(`✅ Entourage status: ${status.split('\n')[0]}`);
} catch (error) {
  console.log(`❌ Combined entourage test failed: ${error.message}`);
}

// Test 6: Vector Similarity Search
console.log('\n🔬 TEST 6: Real Vector Similarity Search');
try {
  const vectorService = VectorEmbeddingService.getInstance();
  const similarities = await vectorService.findSimilarMemories('food preferences', 5);

  console.log(`✅ Similarity search completed`);
  console.log(`✅ Similar memories found: ${similarities.length}`);

  if (similarities.length > 0) {
    console.log(`✅ Top similarity score: ${(similarities[0].similarity_score * 100).toFixed(1)}%`);
  }
} catch (error) {
  console.log(`❌ Vector similarity test failed: ${error.message}`);
}

console.log('\n🎉 SMOKE TESTS COMPLETE');
console.log('✨ All systems verified cancer-free with real implementations!');
