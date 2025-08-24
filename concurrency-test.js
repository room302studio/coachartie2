#!/usr/bin/env node

/**
 * Concurrency Test - Measure performance under concurrent load
 */

const http = require('http');
const { performance } = require('perf_hooks');

const BASE_URL = 'http://localhost:18239';

async function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 18239,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ body, statusCode: res.statusCode });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function testConcurrentRecall(concurrency = 5) {
  console.log(`🚀 Testing ${concurrency} concurrent recall requests...`);
  
  const promises = [];
  const startTime = performance.now();
  
  for (let i = 0; i < concurrency; i++) {
    const promise = makeRequest('POST', '/chat', {
      message: '<capability name="memory" action="recall" query="pizza" />',
      userId: `concurrent-user-${i}`
    });
    promises.push(promise);
  }
  
  try {
    const results = await Promise.all(promises);
    const totalTime = performance.now() - startTime;
    
    console.log(`✅ ${concurrency} requests completed in ${totalTime.toFixed(0)}ms`);
    console.log(`   Average: ${(totalTime / concurrency).toFixed(0)}ms per request`);
    console.log(`   Throughput: ${(concurrency / totalTime * 1000).toFixed(1)} requests/second`);
    
    return { totalTime, avgTime: totalTime / concurrency, throughput: concurrency / totalTime * 1000 };
  } catch (error) {
    console.error(`❌ Concurrency test failed:`, error.message);
    return null;
  }
}

async function runConcurrencyTests() {
  console.log('🧪 CONCURRENCY PERFORMANCE TEST\n');
  
  const levels = [1, 3, 5, 10];
  const results = [];
  
  for (const level of levels) {
    const result = await testConcurrentRecall(level);
    if (result) results.push({ level, ...result });
    await new Promise(resolve => setTimeout(resolve, 2000)); // Cool down
  }
  
  console.log('\n📊 CONCURRENCY RESULTS:');
  console.log('Level | Total Time | Avg Time | Throughput');
  console.log('------|------------|----------|------------');
  
  results.forEach(r => {
    console.log(`${r.level.toString().padStart(5)} | ${r.totalTime.toFixed(0).padStart(10)}ms | ${r.avgTime.toFixed(0).padStart(8)}ms | ${r.throughput.toFixed(1).padStart(10)} req/s`);
  });
}

runConcurrencyTests().then(() => {
  console.log('\n✅ Concurrency test completed!');
}).catch(console.error);