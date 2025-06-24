import { NextRequest, NextResponse } from 'next/server';
import https from 'https';
import { exportStore } from '@/lib/export-store';

const CONSUMER_KEY = '94110-6d5ff7a89d72c869766af0e0';

async function fetchPocketArticles(
  cookieString: string, 
  headers: Record<string, string>, 
  offset: number = 0
): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      consumer_key: CONSUMER_KEY,
      count: 100,
      offset: offset,
      detailType: 'complete',
      sort: 'newest'
    });

    const options = {
      hostname: 'getpocket.com',
      port: 443,
      path: '/v3/get',
      method: 'POST',
      headers: {
        ...headers,
        'cookie': cookieString,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error('Failed to parse response'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function transformArticle(item: any): any {
  // Extract tags as array
  const tags = item.tags ? Object.keys(item.tags) : [];
  
  // Safely parse timestamp
  let addedAt: string;
  try {
    const timestamp = parseInt(item.time_added);
    if (!isNaN(timestamp) && timestamp > 0) {
      addedAt = new Date(timestamp * 1000).toISOString();
    } else {
      addedAt = new Date().toISOString();
    }
  } catch (e) {
    addedAt = new Date().toISOString();
  }
  
  // Safely get domain
  let domain: string;
  try {
    domain = item.domain_metadata?.name || new URL(item.resolved_url || item.given_url).hostname;
  } catch (e) {
    domain = 'unknown';
  }
  
  // Get URL with error logging
  let url = item.resolved_url || item.given_url || item.url;
  if (!url) {
    console.error(`ERROR: Article ${item.item_id} has no URL. Title: "${item.resolved_title || item.given_title || 'Untitled'}"`);
    // Provide a placeholder URL that indicates the issue
    url = `https://getpocket.com/read/${item.item_id}`;
  }
  
  return {
    id: item.item_id,
    title: item.resolved_title || item.given_title || 'Untitled',
    url: url,
    tags: tags,
    featured_image: item.top_image_url || item.image?.src,
    added_at: addedAt,
    excerpt: item.excerpt,
    domain: domain,
    time_to_read: item.time_to_read
  };
}

async function startExportProcess(sessionId: string) {
  const session = exportStore.getSession(sessionId);
  if (!session) {
    console.error('Session not found in startExportProcess:', sessionId);
    return;
  }

  console.log('Starting export process for session:', sessionId);
  exportStore.updateSession(sessionId, { status: 'running' });

  try {
    let offset = 0;
    let hasMore = true;
    let retryCount = 0;
    const maxRetries = 5;
    let totalCount = 0;

    while (hasMore) {
      try {
        const response = await fetchPocketArticles(
          session.auth.cookieString,
          session.auth.headers,
          offset
        );

        console.log('Pocket API response:', { 
          hasError: !!response.error, 
          errorCode: response.error_code,
          status: response.status,
          itemCount: Object.keys(response.list || {}).length 
        });

        if (response.error) {
          // Check for auth errors
          if (response.status === 401 || response.error_code === '107') {
            throw new Error('Authentication failed. Please check your credentials.');
          }
          throw new Error(response.error || 'API error');
        }

        // Get list of items
        const items = response.list || {};
        const itemsArray = Object.values(items);
        
        if (itemsArray.length === 0) {
          hasMore = false;
          break;
        }

        // Transform and store articles
        const articles = itemsArray.map(transformArticle);
        exportStore.addArticles(sessionId, articles);

        // Update total count if available
        if (offset === 0 && response.total) {
          totalCount = parseInt(response.total) || 0;
          exportStore.updateSession(sessionId, { 
            totalCount: totalCount 
          });
        }

        // Check if there are more items
        offset += itemsArray.length;
        hasMore = itemsArray.length === 100; // If we got a full page, there might be more
        
        // Reset retry count on success
        retryCount = 0;

        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error: any) {
        retryCount++;
        
        // Check if it's a rate limit error
        const isRateLimit = error.message?.toLowerCase().includes('rate') || 
                          error.message?.toLowerCase().includes('too many') ||
                          error.status === 429;
        
        if (isRateLimit) {
          // Update session status to rate-limited
          exportStore.updateSession(sessionId, { 
            status: 'rate-limited',
            rateLimitedAt: new Date(),
            rateLimitRetryAfter: retryCount * 60 // seconds
          });
        }
        
        if (retryCount >= maxRetries) {
          throw error;
        }

        // Exponential backoff
        const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 60000);
        console.error(`Error fetching articles, retrying in ${backoffTime}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        
        // Reset rate limit status after waiting
        if (isRateLimit) {
          exportStore.updateSession(sessionId, { 
            status: 'running',
            rateLimitedAt: undefined,
            rateLimitRetryAfter: undefined
          });
        }
      }
    }

    exportStore.updateSession(sessionId, { 
      status: 'completed',
      completedAt: new Date(),
      progress: 100
    });

  } catch (error: any) {
    console.error('Export process error:', error);
    exportStore.updateSession(sessionId, { 
      status: 'error',
      error: error.message || 'Unknown error occurred'
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { cookieString, headers } = await request.json();

    if (!cookieString || !headers) {
      return NextResponse.json(
        { error: 'Missing authentication data' },
        { status: 400 }
      );
    }

    // Create a new export session
    const sessionId = exportStore.createSession({ cookieString, headers });
    console.log('Created session:', sessionId);

    // Verify session was created
    const session = exportStore.getSession(sessionId);
    if (!session) {
      console.error('Failed to create session');
      return NextResponse.json(
        { error: 'Failed to create session' },
        { status: 500 }
      );
    }

    // Start the export process in the background
    startExportProcess(sessionId).catch((error) => {
      console.error('Export process error:', error);
      exportStore.updateSession(sessionId, { 
        status: 'error',
        error: error.message 
      });
    });

    return NextResponse.json({
      success: true,
      sessionId,
      message: 'Export started successfully'
    });

  } catch (error) {
    console.error('Start export error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}