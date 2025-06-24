#!/usr/bin/env node

const https = require('https');
const { getHeaders, getGraphQLEndpoint } = require('./helpers');

// Test different query structures to see what's allowed
const queries = [
  {
    name: "Introspection - Get schema",
    query: `{
      __schema {
        types {
          name
        }
      }
    }`
  },
  {
    name: "Simple user query",
    query: `{
      user {
        id
      }
    }`
  },
  {
    name: "Get user email",
    query: `{
      user {
        email
      }
    }`
  },
  {
    name: "Direct viewer query",
    query: `{
      viewer {
        user {
          savedItems {
            totalCount
          }
        }
      }
    }`
  },
  {
    name: "Me query",
    query: `{
      me {
        savedItems {
          totalCount
        }
      }
    }`
  },
  {
    name: "Current user query", 
    query: `{
      currentUser {
        savedItems {
          totalCount
        }
      }
    }`
  }
];

async function testQuery(queryInfo) {
  console.log(`\nTesting: ${queryInfo.name}`);
  
  const postData = JSON.stringify({
    query: queryInfo.query
  });

  const headers = getHeaders({
    'content-length': Buffer.byteLength(postData),
    'referer': 'https://getpocket.com/saves?src=navbar'
  });

  const options = {
    hostname: 'getpocket.com',
    path: getGraphQLEndpoint(),
    method: 'POST',
    headers: headers
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.errors) {
            console.log(`❌ Error: ${response.errors[0].message}`);
            if (response.errors[0].path) {
              console.log(`   Path: ${response.errors[0].path.join(' → ')}`);
            }
          } else if (response.data) {
            console.log(`✅ Success!`);
            console.log(`   Data:`, JSON.stringify(response.data, null, 2).substring(0, 200) + '...');
          }
          resolve();
        } catch (e) {
          console.log(`❌ Parse error:`, e.message);
          resolve();
        }
      });
    });
    
    req.on('error', (e) => {
      console.log(`❌ Request error:`, e.message);
      resolve();
    });
    
    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('Testing various query structures to understand the API...\n');
  
  for (const query of queries) {
    await testQuery(query);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\nDone! Check which queries succeeded to understand the API structure.');
}

runTests().catch(console.error);