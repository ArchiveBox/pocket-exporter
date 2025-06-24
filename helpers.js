const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CONSUMER_KEY = process.env.POCKET_CONSUMER_KEY || '94110-6d5ff7a89d72c869766af0e0';
const COOKIE_STRING = process.env.COOKIE_STRING;

// For backward compatibility, check if we have the cookie string
if (!COOKIE_STRING) {
  console.error('Error: COOKIE_STRING must be set in .env file');
  console.error('\nTo generate a .env file:');
  console.error('1. Run: node parse_fetch_to_env.js');
  console.error('2. Follow the instructions to paste a fetch request from Pocket');
  process.exit(1);
}

// Common headers for all Pocket API requests
function getHeaders(additionalHeaders = {}) {
  const headers = {};
  
  // Add all HEADER_ environment variables
  Object.entries(process.env).forEach(([key, value]) => {
    if (key.startsWith('HEADER_')) {
      const headerName = key.replace('HEADER_', '').toLowerCase().replace(/_/g, '-');
      headers[headerName] = value;
    }
  });
  
  // Set cookie header
  headers['cookie'] = COOKIE_STRING;
  
  // Add any additional headers (these override env headers)
  return { ...headers, ...additionalHeaders };
}

// Common GraphQL endpoint
function getGraphQLEndpoint() {
  return `/graphql?consumer_key=${CONSUMER_KEY}&enable_cors=1`;
}

// Deep merge function to combine objects
function deepMerge(target, source) {
  const output = Object.assign({}, target);
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target))
          Object.assign(output, { [key]: source[key] });
        else
          output[key] = deepMerge(target[key], source[key]);
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj);
}

// Extract reader slug from various sources
function extractReaderSlug(articleData) {
  // Try to get readerSlug from various sources
  let readerSlug = articleData.item?.readerSlug;
  
  // If no readerSlug, try to use shareId which might be the full slug
  if (!readerSlug && articleData.item?.shareId) {
    readerSlug = articleData.item.shareId;
  }
  
  // If still no slug, use the savedId
  if (!readerSlug && articleData.savedId) {
    readerSlug = articleData.savedId;
  }
  
  return readerSlug;
}

// Rate limiting utilities
let lastRequestTime = 0;
let requestCount = 0;
let rateLimitBackoff = 1000; // Start with 1 second

async function handleRateLimit(error) {
  // Check if it's a rate limit error
  const isRateLimitError = 
    (error.message && error.message.includes('too many requests')) ||
    (error.code === '161') ||
    (error.statusCode === 429);
  
  if (isRateLimitError) {
    console.log(`\n⚠️  Rate limit hit. Backing off for ${rateLimitBackoff/1000} seconds (${Math.round(rateLimitBackoff/60000)} minutes)...`);
    await new Promise(resolve => setTimeout(resolve, rateLimitBackoff));
    
    // Exponential backoff: double the wait time up to 20 minutes
    rateLimitBackoff = Math.min(rateLimitBackoff * 2, 1200000); // 20 minutes max
    return true;
  }
  
  // Reset backoff on successful requests
  rateLimitBackoff = 1000;
  return false;
}

async function respectRateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  // Ensure at least 100ms between requests
  if (timeSinceLastRequest < 100) {
    await new Promise(resolve => setTimeout(resolve, 100 - timeSinceLastRequest));
  }
  
  lastRequestTime = Date.now();
}

// Check if response indicates rate limiting
function isRateLimitResponse(response) {
  if (response.errors) {
    return response.errors.some(error => 
      error.extensions?.code === '161' ||
      (error.message && error.message.toLowerCase().includes('too many requests'))
    );
  }
  return false;
}

// Check if response indicates authentication error
function isAuthError(response) {
  if (response.errors) {
    return response.errors.some(error => 
      error.extensions?.code === 'UNAUTHORIZED_FIELD_OR_TYPE' ||
      error.extensions?.code === 'UNAUTHENTICATED' ||
      (error.message && error.message.toLowerCase().includes('unauthorized')) ||
      (error.message && error.message.toLowerCase().includes('not logged in'))
    );
  }
  return false;
}

// Get current backoff time without triggering it
function getCurrentBackoff() {
  return rateLimitBackoff;
}

// Increase backoff for next time
function increaseBackoff() {
  const oldBackoff = rateLimitBackoff;
  rateLimitBackoff = Math.min(rateLimitBackoff * 2, 1200000); // 20 minutes max
  console.log(`Increasing backoff from ${oldBackoff/1000}s to ${rateLimitBackoff/1000}s (${Math.round(rateLimitBackoff/60000)} minutes)`);
  return rateLimitBackoff;
}

// Reset backoff to initial value
function resetBackoff() {
  rateLimitBackoff = 1000;
}

// For backward compatibility
const PHPSESSID = process.env.PHPSESSID || '';
const AUTH_BEARER = process.env.AUTH_BEARER_DEFAULT || '';

module.exports = {
  CONSUMER_KEY,
  PHPSESSID,
  AUTH_BEARER,
  getHeaders,
  getGraphQLEndpoint,
  deepMerge,
  isObject,
  extractReaderSlug,
  handleRateLimit,
  respectRateLimit,
  isRateLimitResponse,
  isAuthError,
  getCurrentBackoff,
  increaseBackoff,
  resetBackoff
};