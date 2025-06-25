import fs from 'fs';
import path from 'path';
import { exportStore } from './export-store';
import { Article } from '@/types/article';
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

interface FetchState {
  cursor: string | null;
  totalFetched: number;
  articlesMap: Record<string, any>;
  lastSaveTime: number;
}

export async function runFetchArticlesTask(sessionId: string): Promise<void> {
  console.log(`Starting fetch articles task for session ${sessionId}`);
  
  // Get session data
  const session = exportStore.getSession(sessionId);
  if (!session) {
    console.error(`Session ${sessionId} not found`);
    process.exit(1);
  }

  if (!session.auth) {
    console.error(`No auth data found for session ${sessionId}`);
    process.exit(1);
  }

  // Reset fetch task status to running at start
  exportStore.updateFetchTask(sessionId, {
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
  const shouldStop = () => {
    const currentSession = exportStore.getSession(sessionId);
    return currentSession?.currentFetchTask?.status === 'stopped';
  };

  const SESSION_DIR = path.join(process.cwd(), 'sessions', sessionId);
  const ARTICLES_DIR = path.join(SESSION_DIR, 'articles');
  const STATE_FILE = path.join(SESSION_DIR, '.fetch_state.json');

  // Create articles directory if it doesn't exist
  if (!fs.existsSync(ARTICLES_DIR)) {
    fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  }

  // Load saved state
  function loadState(): FetchState | null {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        console.log(`Resuming from cursor: ${state.cursor}`);
        console.log(`Previously fetched: ${state.totalFetched} articles`);
        return state;
      }
    } catch (e: any) {
      console.error('Error loading state:', e.message);
    }
    return null;
  }

  // Save state
  function saveState(state: FetchState) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }

  // Build the GraphQL query - matches EXACTLY what Pocket returns
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
                ... on Item {
                  isArticle
                  hasImage
                  hasVideo
                  timeToRead
                  shareId: id
                  itemId
                  givenUrl
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
  `, ['SavedItemDetails', 'ItemPreview']);

  // Initialize or load state
  let state = loadState();
  let cursor = session.currentFetchTask?.cursor || (state ? state.cursor : null);
  let totalFetched = state ? state.totalFetched : 0;
  let articlesMap = state ? state.articlesMap : {};

  // Variables
  const variables: any = {
    filter: { statuses: ["UNREAD", "ARCHIVED"] },
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
    if (shouldStop()) {
      console.log('\n⏹️  Fetch task stopped by user');
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
      exportStore.updateFetchTask(sessionId, {
        currentID: cursor || 'first-page',
        cursor: cursor
      });

      const response = await makeGraphQLRequest(query, variables, "getItemsUnread", {
        'referer': 'https://getpocket.com/saves?src=navbar'
      });
      
      // Check for authentication error
      if (isAuthError(response)) {
        console.error('\n❌ Authentication error detected. Your session has expired.');
        exportStore.updateFetchTask(sessionId, {
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
          exportStore.updateFetchTask(sessionId, {
            rateLimitedAt: new Date(),
            rateLimitRetryAfter: Math.round(retryAfter / 1000)
          });
          continue; // Retry the same page
        } else {
          console.error('Max retries reached for rate limiting. Stopping.');
          exportStore.updateFetchTask(sessionId, {
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
        exportStore.updateFetchTask(sessionId, {
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

      // Process articles
      let pageArticleCount = 0;
      for (const edge of edges) {
        if (!edge || !edge.node) continue;
        const article = edge.node;
        if (!article.savedId) continue;
        
        // Check if we should stop before processing each article
        if (shouldStop()) {
          console.log('\n⏹️  Fetch task stopped by user during processing');
          hasMore = false;
          break;
        }
        
        pageArticleCount++;
        
        // Deep merge if article already exists
        if (articlesMap[article.savedId]) {
          articlesMap[article.savedId] = deepMerge(articlesMap[article.savedId], article);
        } else {
          articlesMap[article.savedId] = article;
        }
      }
      
      // Update total fetched count with articles from this page
      totalFetched += pageArticleCount;
      
      // If stopped, break out of the main loop
      if (!hasMore && shouldStop()) {
        break;
      }
      
      // Update session with progress - use totalFetched for count
      exportStore.updateFetchTask(sessionId, {
        count: totalFetched,
        total: savedItems.totalCount || totalFetched,
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
        if (!fs.existsSync(articleDir)) {
          fs.mkdirSync(articleDir, { recursive: true });
        }
        
        const articlePath = path.join(articleDir, 'index.json');
        fs.writeFileSync(articlePath, JSON.stringify(article, null, 2));
      }
      
      // Save state periodically
      if (pagesFetched % 5 === 0 || edges.length < ARTICLES_PER_REQUEST) {
        const currentState: FetchState = {
          cursor: pageInfo.endCursor || cursor,
          totalFetched,
          articlesMap,
          lastSaveTime: Date.now()
        };
        saveState(currentState);
        console.log(`Saved state. Total unique articles: ${Object.keys(articlesMap).length}`);
      }
      
      // Update session with current cursor and progress
      exportStore.updateFetchTask(sessionId, {
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
      
      // Save current state before exiting
      const errorState: FetchState = {
        cursor,
        totalFetched,
        articlesMap,
        lastSaveTime: Date.now()
      };
      saveState(errorState);
      
      exportStore.updateFetchTask(sessionId, {
        status: 'error',
        error: error.message,
        endedAt: new Date()
      });
      throw error;
    }
  }
  
  // Final summary
  const articlesArray = Object.values(articlesMap);
  
  console.log('\n📊 Summary:');
  console.log(`Total unique articles: ${articlesArray.length}`);
  console.log(`New articles fetched: ${totalFetched}`);
  console.log(`Articles saved to: ${ARTICLES_DIR}`);
  
  // Update final status
  const finalStatus = shouldStop() ? 'stopped' : 'completed';
  exportStore.updateFetchTask(sessionId, {
    status: finalStatus,
    count: totalFetched,
    total: articlesArray.length,
    endedAt: new Date(),
    cursor: undefined,
    currentID: undefined
  });
  
  // Clean up state file if completed
  if (finalStatus === 'completed' && fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }
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