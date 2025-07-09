import { exportStore } from './export-store';

// Store rate limit state per session - only request timestamps, nothing else
const sessionRateLimits = new Map<string, number[]>();

// Constants for rate limiting
const MAX_REQUESTS_PER_HOUR = 100;
const HOUR_IN_MS = 60 * 60 * 1000;
const FAST_REQUEST_LIMIT = 75; // Send first 75 requests quickly
const FAST_REQUEST_DELAY = 100; // 100ms between fast requests
const SLOW_REQUEST_DELAY = 120 * 1000; // 2 minutes between slow requests (to ensure we stay well under limit)

/**
 * Get request timestamps for a session (empty array if none)
 */
function getRequestTimes(sessionId: string): number[] {
  return sessionRateLimits.get(sessionId) || [];
}

/**
 * Load rate limit state from session storage
 */
export async function loadRateLimitState(sessionId: string): Promise<void> {
  const session = await exportStore.getSession(sessionId);
  if (session?.currentFetchTask?.rateLimitState?.requestTimes) {
    sessionRateLimits.set(sessionId, session.currentFetchTask.rateLimitState.requestTimes);
  }
}

/**
 * Save rate limit state to session storage
 */
async function saveRateLimitState(sessionId: string): Promise<void> {
  let requestTimes = getRequestTimes(sessionId);
  // Clean up old entries before saving (keep only last 100 or those within the hour)
  const now = Date.now();
  requestTimes = requestTimes.filter(time => now - time < HOUR_IN_MS);
  // Also limit to last 100 requests to prevent unbounded growth
  if (requestTimes.length > MAX_REQUESTS_PER_HOUR) {
    requestTimes = requestTimes.slice(-MAX_REQUESTS_PER_HOUR);
  }
  sessionRateLimits.set(sessionId, requestTimes);
  await exportStore.updateFetchTask(sessionId, {
    rateLimitState: { requestTimes }
  });
}

/**
 * Enforce rate limiting for a session
 * Sends first 75 requests quickly, then slows down to avoid hitting 100/hour limit
 */
export async function enforceRateLimit(sessionId: string): Promise<void> {
  let requestTimes = getRequestTimes(sessionId);
  const now = Date.now();
  
  // Clean up old request times (older than 1 hour)
  requestTimes = requestTimes.filter(time => now - time < HOUR_IN_MS);
  sessionRateLimits.set(sessionId, requestTimes);
  
  const requestsInLastHour = requestTimes.length;
  
  // Determine delay based on number of requests in the last hour
  let delay: number;
  
  if (requestsInLastHour < FAST_REQUEST_LIMIT) {
    // Fast mode: only 100ms delay
    delay = FAST_REQUEST_DELAY;
  } else {
    // Slow mode: 2 minute delay to ensure we don't hit the limit
    delay = SLOW_REQUEST_DELAY;
    
    // Check if we just entered slow mode (exactly at the limit)
    if (requestsInLastHour === FAST_REQUEST_LIMIT) {
      console.log(`\n⚠️  Approaching rate limit (${requestsInLastHour}/100 requests in last hour)`);
      console.log(`   Slowing down to 1 request every 2 minutes to avoid hitting limit...`);
    }
  }
  
  // Enforce minimum time between requests
  const lastRequestTime = requestTimes.length > 0 ? requestTimes[requestTimes.length - 1] : 0;
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < delay) {
    const waitTime = delay - timeSinceLastRequest;
    
    if (delay === SLOW_REQUEST_DELAY) {
      console.log(`\n⏱️  Rate limiting: Waiting ${Math.ceil(waitTime / 1000)} seconds before next request...`);
    }
    
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  // If we're at 99 requests, wait until the oldest request expires
  if (requestsInLastHour >= MAX_REQUESTS_PER_HOUR - 1) {
    const oldestRequest = requestTimes[0];
    const waitTime = (oldestRequest + HOUR_IN_MS) - Date.now();
    
    if (waitTime > 0) {
      console.log(`\n🛑 At rate limit (99/100 requests). Waiting ${Math.ceil(waitTime / 1000)} seconds for oldest request to expire...`);
      await new Promise(resolve => setTimeout(resolve, waitTime + 1000)); // Add 1 second buffer
      
      // Re-clean after waiting
      const newNow = Date.now();
      requestTimes = requestTimes.filter(time => newNow - time < HOUR_IN_MS);
      sessionRateLimits.set(sessionId, requestTimes);
    }
  }
  
  // Record this request
  requestTimes.push(Date.now());
  sessionRateLimits.set(sessionId, requestTimes);
  
  // ALWAYS save to disk after every request - disk is the single source of truth
  await saveRateLimitState(sessionId);
}

/**
 * Get current rate limit status for a session
 */
/**
 * Give a rate limit boost by removing the oldest request timestamps
 */
export async function giveRateLimitBoost(sessionId: string, removeCount: number = 25): Promise<void> {
  let requestTimes = getRequestTimes(sessionId);
  
  if (requestTimes.length > removeCount) {
    // Remove the oldest timestamps
    const removed = requestTimes.splice(0, removeCount);
    sessionRateLimits.set(sessionId, requestTimes);
    
    console.log(`  ✅ Removed ${removed.length} oldest request timestamps`);
    console.log(`  📊 Requests in last hour: ${requestTimes.filter(t => Date.now() - t < HOUR_IN_MS).length}/100`);
    
    // Save updated state to disk
    await saveRateLimitState(sessionId);
  }
}

export function getRateLimitStatus(sessionId: string): { 
  requestsInLastHour: number; 
  nextRequestAvailable: Date;
  isInSlowMode: boolean;
} {
  const requestTimes = getRequestTimes(sessionId);
  const now = Date.now();
  
  // Count requests in the last hour
  const requestsInLastHour = requestTimes.filter(time => now - time < HOUR_IN_MS).length;
  
  // Calculate when the next request can be made based on the ACTUAL last request
  let nextRequestTime = now; // Default to now if no requests
  let isInSlowMode = false;
  
  if (requestTimes.length > 0) {
    // Use the last request time from the full array (most recent)
    const lastRequestTime = requestTimes[requestTimes.length - 1];
    
    // Check if we were in slow mode when the last request was made
    // by looking at the request count at that time
    const requestsAtLastRequest = requestTimes.filter(time => time <= lastRequestTime && lastRequestTime - time < HOUR_IN_MS).length;
    const wasInSlowMode = requestsAtLastRequest >= FAST_REQUEST_LIMIT;
    
    // Stay in slow mode until we drop below 50 requests to avoid flapping
    isInSlowMode = wasInSlowMode || requestsInLastHour >= 50;
    
    const delay = isInSlowMode ? SLOW_REQUEST_DELAY : FAST_REQUEST_DELAY;
    nextRequestTime = lastRequestTime + delay;
  }
  
  return {
    requestsInLastHour,
    nextRequestAvailable: new Date(nextRequestTime),
    isInSlowMode
  };
}