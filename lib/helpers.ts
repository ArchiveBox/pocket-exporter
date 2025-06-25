import fs from 'fs';
import path from 'path';
import https from 'https';
import { Article } from '@/types/article';

const CONSUMER_KEY = process.env.POCKET_CONSUMER_KEY || '94110-6d5ff7a89d72c869766af0e0';

// Common headers for all Pocket API requests
export function getHeaders(additionalHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  
  // Get auth from environment or session
  const cookieString = process.env.POCKET_COOKIE || '';
  const headersStr = process.env.POCKET_HEADERS || '{}';
  let parsedHeaders: Record<string, string> = {};
  
  try {
    parsedHeaders = JSON.parse(headersStr);
  } catch (e) {
    console.error('Failed to parse POCKET_HEADERS:', e);
  }
  
  // Set cookie header
  if (cookieString) {
    headers['cookie'] = cookieString;
  }
  
  // Merge all headers
  return { ...headers, ...parsedHeaders, ...additionalHeaders };
}

// Common GraphQL endpoint
export function getGraphQLEndpoint(): string {
  return `/graphql?consumer_key=${CONSUMER_KEY}&enable_cors=1`;
}

// Deep merge function to combine objects
export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
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

export function isObject(obj: any): obj is Record<string, any> {
  return obj && typeof obj === 'object' && !Array.isArray(obj);
}

// Extract reader slug from various sources
export function extractReaderSlug(articleData: Article): string | undefined {
  // Try to get readerSlug from item first (preferred)
  let readerSlug = articleData.item?.readerSlug;
  
  // Fall back to savedId if no readerSlug is available
  if (!readerSlug && articleData.savedId) {
    readerSlug = articleData.savedId;
  }
  
  return readerSlug;
}

// Rate limiting utilities
let lastRequestTime = 0;
let requestCount = 0;
let rateLimitBackoff = 1000; // Start with 1 second

interface RateLimitError {
  message?: string;
  code?: string;
  statusCode?: number;
}

export async function handleRateLimit(error: RateLimitError): Promise<boolean> {
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

export async function respectRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  // Ensure at least 100ms between requests
  if (timeSinceLastRequest < 100) {
    await new Promise(resolve => setTimeout(resolve, 100 - timeSinceLastRequest));
  }
  
  lastRequestTime = Date.now();
}

interface GraphQLResponse {
  data?: any;
  errors?: Array<{
    message?: string;
    extensions?: {
      code?: string;
    };
  }>;
}

// Check if response indicates rate limiting
export function isRateLimitResponse(response: GraphQLResponse): boolean {
  if (response.errors) {
    return response.errors.some(error => 
      error.extensions?.code === '161' ||
      (error.message && error.message.toLowerCase().includes('too many requests'))
    );
  }
  return false;
}

// Check if response indicates authentication error
export function isAuthError(response: GraphQLResponse): boolean {
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
export function getCurrentBackoff(): number {
  return rateLimitBackoff;
}

// Increase backoff for next time
export function increaseBackoff(): number {
  const oldBackoff = rateLimitBackoff;
  rateLimitBackoff = Math.min(rateLimitBackoff * 2, 1200000); // 20 minutes max
  console.log(`Increasing backoff from ${oldBackoff/1000}s to ${rateLimitBackoff/1000}s (${Math.round(rateLimitBackoff/60000)} minutes)`);
  return rateLimitBackoff;
}

// Reset backoff to initial value
export function resetBackoff(): void {
  rateLimitBackoff = 1000;
}

// GraphQL Fragments
export const GRAPHQL_FRAGMENTS: Record<string, string> = {
  SavedItemDetails: `
    fragment SavedItemDetails on SavedItem {
      _createdAt
      _updatedAt
      title
      url
      savedId: id
      status
      isFavorite
      favoritedAt
      isArchived
      archivedAt
      tags {
        id
        name
      }
      annotations {
        highlights {
          id
          quote
          patch
          version
          _createdAt
          _updatedAt
          note {
            text
            _createdAt
            _updatedAt
          }
        }
      }
    }
  `,
  
  ItemDetails: `
    fragment ItemDetails on Item {
      isArticle
      title
      shareId: id
      itemId
      readerSlug
      resolvedId
      resolvedUrl
      domain
      domainMetadata {
        name
      }
      excerpt
      hasImage
      hasVideo
      images {
        caption
        credit
        height
        imageId
        src
        width
      }
      videos {
        vid
        videoId
        type
        src
      }
      topImageUrl
      timeToRead
      givenUrl
      collection {
        imageUrl
        intro
        title
        excerpt
      }
      authors {
        id
        name
        url
      }
      datePublished
      syndicatedArticle {
        slug
        publisher {
          name
          url
        }
      }
    }
  `,
  
  ItemPreview: `
    fragment ItemPreview on PocketMetadata {
      ... on ItemSummary {
        previewId: id
        id
        image {
          caption
          credit
          url
          cachedImages(imageOptions: [{ id: "WebPImage", fileType: WEBP, width: 640 }]) {
            url
            id
          }
        }
        excerpt
        title
        authors {
          name
        }
        domain {
          name
        }
        datePublished
        url
      }
      ... on OEmbed {
        previewId: id
        id
        image {
          caption
          credit
          url
          cachedImages(imageOptions: [{ id: "WebPImage", fileType: WEBP, width: 640 }]) {
            url
            id
          }
        }
        excerpt
        title
        authors {
          name
        }
        domain {
          name
        }
        datePublished
        url
        htmlEmbed
        type
      }
    }
  `
};

// Common GraphQL query builder
export function buildGraphQLQuery(queryBody: string, fragments: string[] = []): string {
  const fragmentsStr = fragments
    .map(fragmentName => GRAPHQL_FRAGMENTS[fragmentName] || '')
    .filter(Boolean)
    .join('\n');
  
  return `${queryBody}\n${fragmentsStr}`;
}

// Common article directory path helper
export function getArticleDir(sessionId: string, articleId: string): string {
  return path.join(process.cwd(), 'sessions', sessionId, 'articles', articleId);
}

// Common article HTML path helper
export function getArticleHtmlPath(sessionId: string, articleId: string): string {
  return path.join(getArticleDir(sessionId, articleId), 'original.html');
}

// Check if article is already downloaded
export async function isArticleDownloaded(sessionId: string, articleId: string): Promise<boolean> {
  const articleHtmlPath = getArticleHtmlPath(sessionId, articleId);
  try {
    await fs.promises.access(articleHtmlPath);
    return true;
  } catch {
    return false;
  }
}

// Common error response handler for API routes
export function createErrorResponse(message: string, statusCode: number = 500): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { 
      status: statusCode,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

// Common success response handler for API routes
export function createSuccessResponse(data: any, statusCode: number = 200): Response {
  return new Response(
    JSON.stringify(data),
    { 
      status: statusCode,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

// Common GraphQL request function
export async function makeGraphQLRequest(
  query: string, 
  variables: any, 
  operationName: string, 
  additionalHeaders: Record<string, string> = {}
): Promise<GraphQLResponse> {
  const postData = JSON.stringify({
    query: query,
    operationName: operationName,
    variables: variables
  });

  const headers = getHeaders({
    'content-length': Buffer.byteLength(postData).toString(),
    ...additionalHeaders
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
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}