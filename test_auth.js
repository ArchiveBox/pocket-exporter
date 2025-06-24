#!/usr/bin/env node

const https = require('https');
const { getHeaders, getGraphQLEndpoint } = require('./helpers');

console.log('Testing Pocket authentication...\n');

// Simple query to test authentication
const testQuery = `
  query GetShareableListPilotStatus {
    shareableListsPilotUser
  }
`;

async function testAuth() {
  const postData = JSON.stringify({
    query: testQuery,
    operationName: "GetShareableListPilotStatus"
  });

  const headers = getHeaders({
    'content-length': Buffer.byteLength(postData),
    'referer': 'https://getpocket.com/saves?src=navbar'
  });

  console.log('Request headers:');
  Object.entries(headers).forEach(([key, value]) => {
    if (key === 'cookie') {
      console.log(`  ${key}: [${value.length} characters]`);
    } else {
      console.log(`  ${key}: ${value}`);
    }
  });

  const options = {
    hostname: 'getpocket.com',
    path: getGraphQLEndpoint(),
    method: 'POST',
    headers: headers
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      
      console.log(`\nResponse status: ${res.statusCode}`);
      console.log('Response headers:', res.headers);
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log('\nResponse:', JSON.stringify(response, null, 2));
          
          if (response.errors) {
            console.error('\n❌ Authentication failed!');
            if (response.errors.some(e => e.extensions?.code === 'UNAUTHORIZED_FIELD_OR_TYPE')) {
              console.error('Your session has expired. Please run: node parse_fetch_to_env.js');
            }
          } else {
            console.log('\n✅ Authentication successful!');
          }
          
          resolve(response);
        } catch (e) {
          console.error('\nFailed to parse response:', e.message);
          console.error('Raw response:', data);
          reject(e);
        }
      });
    });
    
    req.on('error', (e) => {
      console.error('\nRequest failed:', e.message);
      reject(e);
    });
    
    req.write(postData);
    req.end();
  });
}

testAuth().catch(console.error);