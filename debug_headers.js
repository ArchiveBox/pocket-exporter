#!/usr/bin/env node

const { getHeaders } = require('./helpers');

console.log('Current headers being sent:\n');

const headers = getHeaders({
  'content-length': '100',
  'referer': 'https://getpocket.com/saves?src=navbar'
});

Object.entries(headers).forEach(([key, value]) => {
  if (key === 'cookie') {
    console.log(`${key}:`);
    const cookies = value.split('; ');
    cookies.forEach(cookie => {
      const [name, val] = cookie.split('=');
      console.log(`  ${name} = ${val ? val.substring(0, 50) + (val.length > 50 ? '...' : '') : ''}`);
    });
  } else {
    console.log(`${key}: ${value}`);
  }
});

console.log('\n\nEnvironment variables loaded:');
Object.entries(process.env).forEach(([key, value]) => {
  if (key.startsWith('HEADER_') || key.startsWith('COOKIE_') || 
      ['PHPSESSID', 'AUTH_BEARER_DEFAULT', 'SESS_GUID', 'SESS_NONCE'].includes(key)) {
    console.log(`${key}: ${value ? value.substring(0, 50) + (value.length > 50 ? '...' : '') : 'not set'}`);
  }
});