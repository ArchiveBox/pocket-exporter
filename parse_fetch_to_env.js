#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log(`
=== Pocket Fetch Request Parser ===

This script will help you extract authentication data from a Pocket fetch request.

Instructions:
1. Open Pocket in your browser and log in
2. Open Developer Tools (F12)
3. Go to the Network tab
4. Perform any action on Pocket (like loading your saves)
5. Find a GraphQL request to getpocket.com/graphql
6. Right-click the request → Copy → Copy as Node.js fetch
7. Paste the entire fetch request below
8. Press Enter twice when done

Paste your fetch request:
`);

let input = '';
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let emptyLineCount = 0;

rl.on('line', (line) => {
  if (line === '') {
    emptyLineCount++;
    if (emptyLineCount >= 2) {
      rl.close();
      processFetchRequest(input);
    }
  } else {
    emptyLineCount = 0;
    input += line + '\n';
  }
});

function processFetchRequest(fetchCode) {
  try {
    // Extract the headers object using regex
    const headersMatch = fetchCode.match(/"headers"\s*:\s*(\{[\s\S]*?\})\s*(?:,\s*"body"|,\s*"method"|\})/);
    if (!headersMatch) {
      console.error('Error: Could not find headers in the fetch request');
      return;
    }

    // Parse the headers object
    const headersStr = headersMatch[1];
    let headers;
    try {
      // Use Function constructor to safely evaluate the object
      headers = new Function('return ' + headersStr)();
    } catch (e) {
      console.error('Error parsing headers:', e.message);
      return;
    }

    // Extract cookies
    const cookieHeader = headers.cookie || headers.Cookie;
    if (!cookieHeader) {
      console.error('Error: No cookie header found');
      return;
    }

    // Parse cookies
    const cookies = {};
    cookieHeader.split('; ').forEach(cookie => {
      const [key, ...valueParts] = cookie.split('=');
      if (key && valueParts.length > 0) {
        cookies[key] = valueParts.join('='); // Handle cases where value contains =
      }
    });

    // Create .env content with complete cookie string and headers
    let envContent = `# Pocket API Configuration
# Generated on ${new Date().toISOString()}

# Authentication (required for helpers.js compatibility)
PHPSESSID=${cookies.PHPSESSID || ''}
AUTH_BEARER_DEFAULT=${cookies.AUTH_BEARER_default || ''}

# Complete cookie string (preserves exact order from browser)
COOKIE_STRING=${cookieHeader}

# Headers
`;

    // Add all headers except cookie
    Object.entries(headers).forEach(([key, value]) => {
      if (key.toLowerCase() !== 'cookie') {
        const envKey = `HEADER_${key.toUpperCase().replace(/-/g, '_')}`;
        envContent += `${envKey}=${value}\n`;
      }
    });

    // Write to .env file
    const envPath = path.join(__dirname, '.env');
    fs.writeFileSync(envPath, envContent);
    
    console.log('\n✅ Successfully generated .env file!');
    console.log(`\nExtracted values:`);
    console.log(`- PHPSESSID: ${cookies.PHPSESSID ? '✓' : '✗ Missing'}`);
    console.log(`- AUTH_BEARER_DEFAULT: ${cookies.AUTH_BEARER_default ? '✓' : '✗ Missing'}`);
    console.log(`- Cookie string: ${cookieHeader.length} characters`);
    console.log(`- Total headers: ${Object.keys(headers).length - 1}`);
    
    console.log('\nThe .env file has been created with the exact cookie string from your browser.');
    console.log('You can now run the export scripts!');

  } catch (error) {
    console.error('Error processing fetch request:', error.message);
    console.error('Please make sure you pasted a valid fetch request');
  }
}