#!/usr/bin/env node

const http = require('http');

let PORT = process.env.PORT || 3000;
const HOST = 'localhost';

// Try to detect the actual port by checking both 3000 and 3001
async function detectPort() {
  const ports = [3000, 3001];
  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://${HOST}:${port}`, (res) => {
          resolve();
        });
        req.on('error', reject);
        req.setTimeout(1000);
        req.end();
      });
      return port;
    } catch (e) {
      // Try next port
    }
  }
  return PORT; // Default
}

// Wait for server to be ready
async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      // Try to detect port on first attempt
      if (i === 0) {
        const detectedPort = await detectPort();
        if (detectedPort !== PORT) {
          PORT = detectedPort;
          console.log(`Detected server on port ${PORT}`);
        }
      }
      
      await new Promise((resolve, reject) => {
        const req = http.get(`http://${HOST}:${PORT}`, (res) => {
          if (res.statusCode === 200 || res.statusCode === 404) {
            resolve();
          } else {
            reject(new Error(`Status ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.end();
      });
      return true;
    } catch (e) {
      // console.log(`Waiting for server on port ${PORT}... (${i + 1}/${retries})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return false;
}

// Warm up an endpoint
async function warmupEndpoint(path, method = 'GET') {
  return new Promise((resolve) => {
    console.log(`Warming up ${method} ${path}...`);
    
    const options = {
      hostname: HOST,
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log(`✓ ${method} ${path} - ${res.statusCode}`);
        resolve();
      });
    });

    req.on('error', (error) => {
      console.error(`✗ ${method} ${path} - Error:`, error.message);
      resolve();
    });

    // Send dummy data for POST requests
    if (method === 'POST') {
      req.write(JSON.stringify({ warmup: true }));
    }

    req.end();
  });
}

async function main() {
  console.log('Waiting for Next.js server to start...');
  
  const serverReady = await waitForServer();
  if (!serverReady) {
    // console.error('Server failed to start');
    process.exit(1);
  }

  console.log('\nWarming up API endpoints...\n');

  // List of endpoints to warm up
  const endpoints = [
    { path: '/', method: 'GET' },
    { path: '/api/task/save-pocket-auth', method: 'POST' },
    { path: '/api/task/fetch-articles-list/start?sessionId=warmup', method: 'POST' },
    { path: '/api/task/fetch-articles-list/stop?sessionId=warmup', method: 'POST' },
    { path: '/api/task/download-articles/start?sessionId=warmup', method: 'POST' },
    { path: '/api/task/download-articles/stop?sessionId=warmup', method: 'POST' },
    { path: '/api/export/status?sessionId=warmup', method: 'GET' },
    { path: '/api/export/download-single?sessionId=warmup&articleId=warmup', method: 'POST' },
    { path: '/api/export/download?sessionId=warmup&format=json', method: 'GET' },
    { path: '/api/export/article-html?sessionId=warmup&articleId=warmup', method: 'GET' },
  ];

  // Warm up all endpoints
  for (const endpoint of endpoints) {
    await warmupEndpoint(endpoint.path, endpoint.method);
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log('\n✅ API warmup complete!\n');
}

main().catch(console.error);
