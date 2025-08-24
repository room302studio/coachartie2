#!/usr/bin/env node

/**
 * Memory Recall Benchmark Suite
 * Tests recall time, breadth, and accuracy metrics
 */

const http = require('http');
const { performance } = require('perf_hooks');

const BASE_URL = 'http://localhost:18239';
const TEST_USER = 'benchmark-user';

// Test dataset - known memories with expected recall patterns
const TEST_MEMORIES = [
  // Food preferences 
  { content: "I love pizza margherita with fresh basil", importance: 8, tags: ["food", "pizza", "italian"] },
  { content: "Sushi is my favorite Japanese food", importance: 7, tags: ["food", "sushi", "japanese"] },
  { content: "I'm allergic to peanuts", importance: 10, tags: ["food", "allergy", "health"] },
  
  // Work/Career
  { content: "I work as a software engineer at TechCorp", importance: 6, tags: ["work", "career", "tech"] },
  { content: "My favorite programming language is Python", importance: 5, tags: ["work", "programming", "python"] },
  { content: "I have a meeting with Sarah tomorrow at 2pm", importance: 8, tags: ["work", "meeting", "schedule"] },
  
  // Hobbies/Interests
  { content: "I play guitar in my spare time", importance: 4, tags: ["hobby", "music", "guitar"] },
  { content: "I love hiking in the mountains", importance: 6, tags: ["hobby", "outdoor", "hiking"] },
  { content: "My favorite book is Dune by Frank Herbert", importance: 5, tags: ["hobby", "reading", "scifi"] },
  
  // Personal
  { content: "My birthday is March 15th", importance: 9, tags: ["personal", "birthday", "date"] },
  { content: "I have a cat named Whiskers", importance: 7, tags: ["personal", "pet", "cat"] },
  { content: "I live in San Francisco", importance: 8, tags: ["personal", "location", "city"] },
  
  // Travel
  { content: "I visited Tokyo last year and loved it", importance: 6, tags: ["travel", "tokyo", "japan"] },
  { content: "Planning a trip to Europe next summer", importance: 7, tags: ["travel", "europe", "planning"] },
  { content: "The best coffee I had was in Italy", importance: 4, tags: ["travel", "coffee", "italy"] }
];

// Test queries with expected recall patterns
const TEST_QUERIES = [
  // Exact matches
  { query: "pizza", expectedKeywords: ["pizza", "margherita"], category: "exact" },
  { query: "sushi", expectedKeywords: ["sushi", "japanese"], category: "exact" },
  
  // Semantic matches
  { query: "food preferences", expectedKeywords: ["pizza", "sushi", "allergy"], category: "semantic" },
  { query: "work", expectedKeywords: ["software", "engineer", "python"], category: "semantic" },
  
  // Contextual matches
  { query: "japanese", expectedKeywords: ["sushi", "tokyo"], category: "contextual" },
  { query: "outdoor activities", expectedKeywords: ["hiking", "mountains"], category: "contextual" },
  
  // Complex queries
  { query: "what do I do for fun", expectedKeywords: ["guitar", "hiking", "reading"], category: "complex" },
  { query: "tell me about my pets", expectedKeywords: ["cat", "whiskers"], category: "complex" },
  
  // Fuzzy/partial matches
  { query: "program", expectedKeywords: ["programming", "python"], category: "fuzzy" },
  { query: "meet", expectedKeywords: ["meeting", "sarah"], category: "fuzzy" }
];

class MemoryBenchmark {
  constructor() {
    this.results = {
      setup: { totalTime: 0, successCount: 0, errorCount: 0 },
      recall: {
        times: [],
        accuracy: [],
        breadth: [],
        byCategory: {}
      }
    };
  }

  async makeRequest(method, path, data = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: 18239,
        path: path,
        method: method,
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            resolve(result);
          } catch (e) {
            resolve({ body, statusCode: res.statusCode });
          }
        });
      });

      req.on('error', reject);
      
      if (data) {
        req.write(JSON.stringify(data));
      }
      
      req.end();
    });
  }

  async waitForJob(jobUrl, maxWaitMs = 15000) {
    const startTime = performance.now();
    
    while (performance.now() - startTime < maxWaitMs) {
      const result = await this.makeRequest('GET', jobUrl);
      
      if (result.status === 'completed') {
        return {
          response: result.response,
          totalTime: performance.now() - startTime
        };
      } else if (result.status === 'failed') {
        throw new Error(`Job failed: ${result.error}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    throw new Error('Job timeout');
  }

  async storeMemory(memory) {
    const startTime = performance.now();
    
    try {
      const message = `<capability name="memory" action="remember" content="${memory.content}" importance="${memory.importance}" />`;
      const result = await this.makeRequest('POST', '/chat', {
        message,
        userId: TEST_USER
      });
      
      if (result.jobUrl) {
        await this.waitForJob(result.jobUrl);
        this.results.setup.successCount++;
      } else {
        this.results.setup.errorCount++;
      }
      
      return performance.now() - startTime;
    } catch (error) {
      console.error(`Error storing memory: ${memory.content}`, error.message);
      this.results.setup.errorCount++;
      return performance.now() - startTime;
    }
  }

  async testRecall(testQuery) {
    const startTime = performance.now();
    
    try {
      const message = `<capability name="memory" action="recall" query="${testQuery.query}" />`;
      const result = await this.makeRequest('POST', '/chat', {
        message,
        userId: TEST_USER
      });
      
      if (result.jobUrl) {
        const jobResult = await this.waitForJob(result.jobUrl);
        const totalTime = performance.now() - startTime;
        
        // Analyze response for accuracy and breadth
        const response = jobResult.response.toLowerCase();
        const foundKeywords = testQuery.expectedKeywords.filter(keyword => 
          response.includes(keyword.toLowerCase())
        );
        
        const accuracy = foundKeywords.length / testQuery.expectedKeywords.length;
        const breadth = foundKeywords.length;
        
        return {
          time: totalTime,
          accuracy,
          breadth,
          foundKeywords,
          response: jobResult.response,
          success: true
        };
      } else {
        return {
          time: performance.now() - startTime,
          accuracy: 0,
          breadth: 0,
          foundKeywords: [],
          response: 'No job URL returned',
          success: false
        };
      }
    } catch (error) {
      return {
        time: performance.now() - startTime,
        accuracy: 0,
        breadth: 0,
        foundKeywords: [],
        response: error.message,
        success: false
      };
    }
  }

  async setupTestData() {
    console.log('🏗️  Setting up test data...');
    const setupStartTime = performance.now();
    
    for (let i = 0; i < TEST_MEMORIES.length; i++) {
      const memory = TEST_MEMORIES[i];
      console.log(`   Storing memory ${i + 1}/${TEST_MEMORIES.length}: ${memory.content.substring(0, 40)}...`);
      
      const time = await this.storeMemory(memory);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
    }
    
    this.results.setup.totalTime = performance.now() - setupStartTime;
    console.log(`✅ Setup complete: ${this.results.setup.successCount} stored, ${this.results.setup.errorCount} errors`);
  }

  async runRecallTests() {
    console.log('🧠 Running recall tests...');
    
    for (let i = 0; i < TEST_QUERIES.length; i++) {
      const testQuery = TEST_QUERIES[i];
      console.log(`   Testing query ${i + 1}/${TEST_QUERIES.length}: "${testQuery.query}" (${testQuery.category})`);
      
      const result = await this.testRecall(testQuery);
      
      // Store results
      this.results.recall.times.push(result.time);
      this.results.recall.accuracy.push(result.accuracy);
      this.results.recall.breadth.push(result.breadth);
      
      // Group by category
      if (!this.results.recall.byCategory[testQuery.category]) {
        this.results.recall.byCategory[testQuery.category] = {
          times: [], accuracy: [], breadth: [], tests: []
        };
      }
      
      this.results.recall.byCategory[testQuery.category].times.push(result.time);
      this.results.recall.byCategory[testQuery.category].accuracy.push(result.accuracy);
      this.results.recall.byCategory[testQuery.category].breadth.push(result.breadth);
      this.results.recall.byCategory[testQuery.category].tests.push({
        query: testQuery.query,
        expected: testQuery.expectedKeywords,
        found: result.foundKeywords,
        accuracy: result.accuracy,
        time: result.time
      });
      
      console.log(`      ⏱️  ${result.time.toFixed(0)}ms | 🎯 ${(result.accuracy * 100).toFixed(1)}% | 📊 ${result.breadth}/${testQuery.expectedKeywords.length} keywords`);
      
      await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limiting
    }
  }

  generateReport() {
    const recall = this.results.recall;
    
    // Calculate statistics
    const avgTime = recall.times.reduce((a, b) => a + b, 0) / recall.times.length;
    const avgAccuracy = recall.accuracy.reduce((a, b) => a + b, 0) / recall.accuracy.length;
    const avgBreadth = recall.breadth.reduce((a, b) => a + b, 0) / recall.breadth.length;
    
    const minTime = Math.min(...recall.times);
    const maxTime = Math.max(...recall.times);
    
    console.log('\n📊 MEMORY RECALL BENCHMARK RESULTS\n');
    console.log('=' .repeat(50));
    
    console.log('\n🏗️  SETUP METRICS:');
    console.log(`   Total setup time: ${this.results.setup.totalTime.toFixed(0)}ms`);
    console.log(`   Memories stored: ${this.results.setup.successCount}/${TEST_MEMORIES.length}`);
    console.log(`   Success rate: ${(this.results.setup.successCount / TEST_MEMORIES.length * 100).toFixed(1)}%`);
    
    console.log('\n⏱️  SPEED METRICS:');
    console.log(`   Average recall time: ${avgTime.toFixed(0)}ms`);
    console.log(`   Fastest recall: ${minTime.toFixed(0)}ms`);
    console.log(`   Slowest recall: ${maxTime.toFixed(0)}ms`);
    console.log(`   Standard deviation: ${this.calculateStdDev(recall.times).toFixed(0)}ms`);
    
    console.log('\n🎯 ACCURACY METRICS:');
    console.log(`   Average accuracy: ${(avgAccuracy * 100).toFixed(1)}%`);
    console.log(`   Average breadth: ${avgBreadth.toFixed(1)} keywords found`);
    console.log(`   Perfect recalls: ${recall.accuracy.filter(a => a === 1).length}/${recall.accuracy.length}`);
    
    console.log('\n📊 BY QUERY CATEGORY:');
    Object.entries(recall.byCategory).forEach(([category, data]) => {
      const catAvgTime = data.times.reduce((a, b) => a + b, 0) / data.times.length;
      const catAvgAcc = data.accuracy.reduce((a, b) => a + b, 0) / data.accuracy.length;
      console.log(`   ${category.toUpperCase()}:`);
      console.log(`     Time: ${catAvgTime.toFixed(0)}ms | Accuracy: ${(catAvgAcc * 100).toFixed(1)}%`);
    });
    
    console.log('\n🔍 DETAILED RESULTS:');
    Object.entries(recall.byCategory).forEach(([category, data]) => {
      console.log(`\n   ${category.toUpperCase()} QUERIES:`);
      data.tests.forEach(test => {
        console.log(`     "${test.query}"`);
        console.log(`       Expected: [${test.expected.join(', ')}]`);
        console.log(`       Found: [${test.found.join(', ')}]`);
        console.log(`       Accuracy: ${(test.accuracy * 100).toFixed(1)}% | Time: ${test.time.toFixed(0)}ms`);
      });
    });
    
    console.log('\n=' .repeat(50));
  }

  calculateStdDev(values) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map(value => Math.pow(value - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquareDiff);
  }

  async run() {
    console.log('🚀 Starting Memory Recall Benchmark Suite\n');
    
    try {
      await this.setupTestData();
      await this.runRecallTests();
      this.generateReport();
    } catch (error) {
      console.error('❌ Benchmark failed:', error);
      process.exit(1);
    }
  }
}

// Run the benchmark
if (require.main === module) {
  const benchmark = new MemoryBenchmark();
  benchmark.run().then(() => {
    console.log('\n✅ Benchmark completed successfully!');
    process.exit(0);
  }).catch(error => {
    console.error('❌ Benchmark failed:', error);
    process.exit(1);
  });
}

module.exports = MemoryBenchmark;