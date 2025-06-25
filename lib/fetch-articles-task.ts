import fs from 'fs';
import path from 'path';
import { exportStore } from './export-store';
import { Article } from '@/types/article';
import { canFetchMoreArticles, recordArticlesFetched, hasValidPayment } from './session-utils';
import { atomicWriteJson } from './atomic-write';
import { 
  getHeaders, 
  getGraphQLEndpoint, 
  deepMerge, 
  handleRateLimit, 
  respectRateLimit, 
  isRateLimitResponse, 
  isAuthError, 
  buildGraphQLQuery, 
  GRAPHQL_FRAGMENTS, 
  makeGraphQLRequest 
} from './helpers';

const ARTICLES_PER_REQUEST = 1000;


export async function runFetchArticlesTask(sessionId: string): Promise<void> {
  console.log(`Starting fetch articles task for session ${sessionId}`);
  
  // Get session data
  const session = await exportStore.getSession(sessionId);
  if (!session) {
    console.error(`Session ${sessionId} not found`);
    process.exit(1);
  }

  if (!session.auth) {
    console.error(`No auth data found for session ${sessionId}`);
    process.exit(1);
  }

  // Reset fetch task status to running at start
  await exportStore.updateFetchTask(sessionId, {
    status: 'running',
    startedAt: new Date(),
    count: 0,
    total: 0,
    pid: process.pid,
    error: undefined,
    rateLimitedAt: undefined,
    rateLimitRetryAfter: undefined,
    cursor: undefined,
    currentID: undefined
  });

  // Check if task should stop
  const shouldStop = async () => {
    const currentSession = await exportStore.getSession(sessionId);
    return currentSession?.currentFetchTask?.status === 'stopped';
  };

  const SESSION_DIR = path.join(process.cwd(), 'sessions', sessionId);
  const ARTICLES_DIR = path.join(SESSION_DIR, 'articles');

  // Create articles directory if it doesn't exist
  await fs.promises.mkdir(ARTICLES_DIR, { recursive: true }).catch(() => {});

  // Build the GraphQL query - request ALL fields including readerSlug and article content
  const query = buildGraphQLQuery(`
    query GetSavedItems(
      $filter: SavedItemsFilter
      $sort: SavedItemsSort
      $pagination: PaginationInput
    ) {
      user {
        savedItems(filter: $filter, sort: $sort, pagination: $pagination) {
          edges {
            cursor
            node {
              ...SavedItemDetails
              item {
                ...ItemDetails
                ... on Item {
                  readerSlug
                  article
                  preview {
                    ...ItemPreview
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
          totalCount
        }
      }
    }
  `, ['SavedItemDetails', 'ItemDetails', 'ItemPreview']);

  // Initialize cursor from session
  let cursor = session.currentFetchTask?.cursor || null;
  let totalFetched = 0;

  // Variables - fetch ALL articles regardless of status
  const variables: any = {
    // No filter property at all to get all articles
    sort: { sortBy: "CREATED_AT", sortOrder: "DESC" },
    pagination: { first: ARTICLES_PER_REQUEST }
  };

  // Update session headers with auth data
  process.env.POCKET_COOKIE = session.auth.cookieString;
  process.env.POCKET_HEADERS = JSON.stringify(session.auth.headers);

  let hasMore = true;
  let retryCount = 0;
  const maxRetries = 10;
  let pagesFetched = 0;

  // Main fetch loop
  while (hasMore) {
    // Check if we should stop
    if (await shouldStop()) {
      console.log('\n⏹️  Fetch task stopped by user');
      break;
    }
    
    // Check if we've hit the paywall limit
    if (!(await canFetchMoreArticles(sessionId, totalFetched))) {
      console.log('\n⚠️  Reached free tier limit of 100 articles. Payment required to continue.');
      await exportStore.updateFetchTask(sessionId, {
        status: 'stopped',
        error: 'Payment required - reached 100 article limit',
        endedAt: new Date()
      });
      break;
    }

    if (cursor) {
      variables.pagination.after = cursor;
    }

    try {
      // Respect rate limits
      await respectRateLimit();
      
      console.log(`\nFetching page ${cursor ? `after cursor ${cursor}` : '(first page)'}...`);
      
      // Update fetch task status
      await exportStore.updateFetchTask(sessionId, {
        currentID: cursor || 'first-page',
        cursor: cursor
      });

      const response = await makeGraphQLRequest(query, variables, "getItemsUnread", {
        'referer': 'https://getpocket.com/saves?src=navbar'
      });
      
      // Check for authentication error
      if (isAuthError(response)) {
        console.error('\n❌ Authentication error detected. Your session has expired.');
        await exportStore.updateFetchTask(sessionId, {
          status: 'error',
          error: 'Authentication expired',
          endedAt: new Date()
        });
        break;
      }
      
      // Check for rate limit response
      if (isRateLimitResponse(response)) {
        console.error('Rate limit response:', JSON.stringify(response, null, 2));
        if (retryCount < maxRetries) {
          retryCount++;
          const retryAfter = await handleRateLimit({ code: '161' });
          await exportStore.updateFetchTask(sessionId, {
            rateLimitedAt: new Date(),
            rateLimitRetryAfter: Math.round(retryAfter / 1000)
          });
          continue; // Retry the same page
        } else {
          console.error('Max retries reached for rate limiting. Stopping.');
          await exportStore.updateFetchTask(sessionId, {
            status: 'error',
            error: 'Max rate limit retries exceeded',
            endedAt: new Date()
          });
          break;
        }
      }
      
      // Reset retry count on successful request
      retryCount = 0;
      
      if (!response.data || !response.data.user || !response.data.user.savedItems) {
        console.error('Invalid response structure:', JSON.stringify(response, null, 2));
        await exportStore.updateFetchTask(sessionId, {
          status: 'error',
          error: 'Invalid response structure',
          endedAt: new Date()
        });
        break;
      }

      const savedItems = response.data.user.savedItems;
      const edges = savedItems.edges || [];
      const pageInfo = savedItems.pageInfo || {};
      
      console.log(`Fetched ${edges.length} articles`);
      pagesFetched++;

      // Update total fetched count
      totalFetched += edges.filter((edge: any) => edge?.node?.savedId).length;
      
      // Record the number of articles fetched for payment tracking
      recordArticlesFetched(sessionId, totalFetched);
      
      // Update session with progress - use totalFetched for count
      // Note: Pocket's API may report incorrect totalCount (e.g., capped at 5000)
      // So we use the greater of totalCount or totalFetched
      const reportedTotal = savedItems.totalCount || 0;
      const estimatedTotal = Math.max(reportedTotal, totalFetched);
      
      await exportStore.updateFetchTask(sessionId, {
        count: totalFetched,
        total: pageInfo.hasNextPage ? estimatedTotal + 1000 : estimatedTotal, // Add buffer if more pages exist
        rateLimitedAt: undefined,
        rateLimitRetryAfter: undefined
      });
      
      // Save individual article files
      const articlesToSave = edges.map((edge: any) => edge.node).filter((a: any) => a && a.savedId);
      for (const article of articlesToSave) {
        // Use savedId instead of id for the directory name
        const savedId = article.savedId;
        const articleDir = path.join(ARTICLES_DIR, savedId);
        
        // Create article directory if it doesn't exist
        await fs.promises.mkdir(articleDir, { recursive: true }).catch(() => {});
        
        // Always create a copy to avoid modifying the original
        const articleCopy = JSON.parse(JSON.stringify(article));
        
        // Add the Archive.org URL
        if (articleCopy.url) {
          articleCopy.archivedotorg_url = `https://web.archive.org/web/${articleCopy.url}`;
        }
        
        // Check if article HTML content is included (should only be at item.article)
        if (articleCopy.item?.article) {
          const articleContent = articleCopy.item.article;
          delete articleCopy.item.article;
          
          // Save the HTML content separately
          const articleHtmlPath = path.join(articleDir, 'article.html');
          await fs.promises.writeFile(articleHtmlPath, articleContent);
          console.log(`  ✓ Saved article HTML for ${savedId}`);
        }
        
        // Always save the metadata (without article content)
        const articlePath = path.join(articleDir, 'index.json');
        await atomicWriteJson(articlePath, articleCopy);
      }
      
      // Update session with current cursor and progress
      await exportStore.updateFetchTask(sessionId, {
        cursor: pageInfo.endCursor || cursor,
        currentID: edges.length > 0 ? edges[edges.length - 1].node?.savedId : undefined
      });
      
      // Check if there are more pages
      hasMore = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
      
      if (!hasMore) {
        console.log('\n✅ No more pages to fetch!');
      }
    } catch (error: any) {
      console.error('Error fetching articles:', error);
      
      await exportStore.updateFetchTask(sessionId, {
        status: 'error',
        error: error.message,
        endedAt: new Date()
      });
      throw error;
    }
  }
  
  // Final summary
  console.log('\n📊 Summary:');
  console.log(`Total articles fetched: ${totalFetched}`);
  console.log(`Articles saved to: ${ARTICLES_DIR}`);
  
  // Update final status
  const finalStatus = await shouldStop() ? 'stopped' : 'completed';
  await exportStore.updateFetchTask(sessionId, {
    status: finalStatus,
    count: totalFetched,
    total: totalFetched,
    endedAt: new Date(),
    cursor: undefined,
    currentID: undefined
  });
}

// Run if called directly
if (require.main === module) {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Usage: tsx fetch-articles-task.ts <sessionId>');
    process.exit(1);
  }
  
  runFetchArticlesTask(sessionId).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}