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
import { enforceRateLimit, loadRateLimitState, getRateLimitStatus, giveRateLimitBoost } from './rate-limiter';

const ARTICLES_PER_REQUEST = 1000;

// Helper to analyze gaps in saved articles
async function analyzeArticleGaps(articlesDir: string): Promise<{
  totalArticles: number;
  oldestId: number;
  newestId: number;
  largestGaps: Array<{ start: number; end: number; size: number }>;
}> {
  const articleDirs = await fs.promises.readdir(articlesDir).catch(() => []);
  const articleIds = articleDirs
    .filter(dir => /^\d+$/.test(dir))
    .map(id => parseInt(id))
    .filter(id => !isNaN(id))
    .sort((a, b) => b - a); // Sort descending

  if (articleIds.length === 0) {
    return {
      totalArticles: 0,
      oldestId: 0,
      newestId: 0,
      largestGaps: []
    };
  }

  // Find gaps
  const gaps: Array<{ start: number; end: number; size: number }> = [];
  for (let i = 0; i < articleIds.length - 1; i++) {
    const gap = articleIds[i] - articleIds[i + 1];
    if (gap > 100) {
      gaps.push({
        start: articleIds[i],
        end: articleIds[i + 1],
        size: gap
      });
    }
  }

  // Sort gaps by size and take top 5
  gaps.sort((a, b) => b.size - a.size);

  return {
    totalArticles: articleIds.length,
    oldestId: articleIds[articleIds.length - 1],
    newestId: articleIds[0],
    largestGaps: gaps.slice(0, 5)
  };
}


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

  // Load rate limit state from session
  await loadRateLimitState(sessionId);
  
  // Initialize cursor from session and check for resumption
  let cursor = session.currentFetchTask?.cursor || null;
  let totalFetched = session.currentFetchTask?.count || 0;
  
  // If this is a fresh start (no cursor), give a rate limit boost
  if (!cursor && totalFetched === 0) {
    console.log('🚀 Fresh fetch detected - applying rate limit boost...');
    await giveRateLimitBoost(sessionId, 50);
  }
  
  // Analyze current state of saved articles
  if (totalFetched > 0 || cursor) {
    const gapAnalysis = await analyzeArticleGaps(ARTICLES_DIR);
    console.log(`\n📊 Article collection analysis:`);
    console.log(`   Total saved: ${gapAnalysis.totalArticles} articles`);
    if (gapAnalysis.totalArticles > 0) {
      console.log(`   Range: ${gapAnalysis.newestId} (newest) to ${gapAnalysis.oldestId} (oldest)`);
      if (gapAnalysis.largestGaps.length > 0) {
        console.log(`   Largest gaps in collection:`);
        gapAnalysis.largestGaps.forEach((gap, i) => {
          console.log(`     ${i + 1}. Between ${gap.start} and ${gap.end} (${gap.size} articles missing)`);
        });
      }
    }
  }
  let skipDuplicatePages = 0; // Track how many pages of pure duplicates we've seen
  const MAX_DUPLICATE_PAGES = 5; // After this many pages of duplicates, try to jump ahead
  let savedArticleIds: Set<string> | null = null; // Cache of saved article IDs for gap detection
  
  if (cursor) {
    console.log(`\n🔄 Resuming export from cursor: ${cursor}`);
    console.log(`   Already fetched: ${totalFetched} articles`);
    
    // Show rate limit status
    const rateLimitStatus = getRateLimitStatus(sessionId);
    console.log(`   Rate limit: ${rateLimitStatus.requestsInLastHour}/100 requests in last hour`);
    if (rateLimitStatus.isInSlowMode) {
      console.log(`   ⚠️  In slow mode to avoid rate limiting`);
    }
  }
  
  // If we have a lot of articles already, do a quick sample to find gaps
  if (totalFetched > 1000) {
    console.log(`\n🔍 Smart resume: Sampling collection to find new articles...`);
    
    // Try fetching from the end (oldest articles with ASC order)
    const endVariables = {
      sort: { sortBy: "CREATED_AT", sortOrder: "ASC" },
      pagination: { first: 10 } // Just sample 10 articles
    };
    
    try {
      await enforceRateLimit(sessionId);
      const endResponse = await makeGraphQLRequest(query, endVariables, "getItemsUnread", {
        'referer': 'https://getpocket.com/saves?src=navbar'
      });
      
      if (!isAuthError(endResponse) && !isRateLimitResponse(endResponse)) {
        const endItems = endResponse.data?.user?.savedItems?.edges || [];
        let newFound = 0;
        
        for (const edge of endItems) {
          if (edge?.node?.savedId) {
            const indexPath = path.join(ARTICLES_DIR, edge.node.savedId, 'index.json');
            try {
              await fs.promises.access(indexPath);
              // Article exists
            } catch {
              // New article found!
              newFound++;
            }
          }
        }
        
        if (newFound > 0) {
          console.log(`   ✓ Found ${newFound} new articles at the beginning (oldest). Switching to ASC order.`);
          variables.sort.sortOrder = "ASC";
          cursor = null; // Start from beginning with ASC order
        } else {
          console.log(`   ℹ️  No new articles found at the beginning. Continuing with current cursor.`);
        }
      }
    } catch (error) {
      console.log(`   ⚠️  Sample failed, continuing with current cursor`);
    }
  }

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
      // Enforce our rate limiting (100 requests per hour)
      await enforceRateLimit(sessionId);
      
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
        // Check if this is a "Cursor not found" error
        if (response.errors && response.errors.some((e: any) => e.message === "Cursor not found.")) {
          console.log('   ⚠️  Cursor not found error - resetting to beginning');
          cursor = null;
          skipDuplicatePages = 0;
          continue; // Retry without cursor
        }
        
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

      // Don't update totalFetched here - wait until we know how many are actually new
      const fetchedInThisBatch = edges.filter((edge: any) => edge?.node?.savedId).length;
      
      // Update session with progress - use totalFetched for count
      // Note: Pocket's API may report incorrect totalCount (e.g., capped at 5000)
      // So we use the greater of totalCount or totalFetched
      const reportedTotal = savedItems.totalCount || 0;
      const actualSavedCount = await exportStore.getSessionArticleIds(sessionId).then(ids => ids.length);
      const estimatedTotal = Math.max(reportedTotal, actualSavedCount, totalFetched);
      
      await exportStore.updateFetchTask(sessionId, {
        count: actualSavedCount, // Use actual count from disk
        total: pageInfo.hasNextPage ? estimatedTotal + 100 : estimatedTotal, // Small buffer if more pages exist
        rateLimitedAt: undefined,
        rateLimitRetryAfter: undefined
      });
      
      // Save individual article files
      const articlesToSave = edges.map((edge: any) => edge.node).filter((a: any) => a && a.savedId);
      
      // Debug: Check if we're losing articles
      if (articlesToSave.length !== edges.length) {
        console.log(`  ⚠️  Only ${articlesToSave.length} of ${edges.length} articles have valid savedId`);
      }
      
      let skippedExisting = 0;
      let savedNew = 0;
      
      for (const article of articlesToSave) {
        // Use savedId instead of id for the directory name
        const savedId = article.savedId;
        const articleDir = path.join(ARTICLES_DIR, savedId);
        
        // Check if article already exists
        const indexPath = path.join(articleDir, 'index.json');
        try {
          await fs.promises.access(indexPath);
          skippedExisting++;
          continue; // Skip if already exists
        } catch {
          // Article doesn't exist, proceed to save
        }
        
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
        savedNew++;
      }
      
      if (skippedExisting > 0) {
        console.log(`  ⚠️  Skipped ${skippedExisting} duplicate articles, saved ${savedNew} new`);
      }
      
      // Only increment totalFetched by the number of NEW articles
      totalFetched += savedNew;
      
      // Record the number of articles fetched for payment tracking
      recordArticlesFetched(sessionId, totalFetched);
      
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
      
      // If we fetched a full page but saved zero new articles, track it
      if (edges.length > 0 && savedNew === 0) {
        skipDuplicatePages++;
        console.log(`  ℹ️  All ${edges.length} articles were duplicates (already saved) - ${skipDuplicatePages} pages in a row`);
        
        // If we've seen too many duplicate pages, try to intelligently jump to a gap
        if (skipDuplicatePages >= MAX_DUPLICATE_PAGES && pageInfo.hasNextPage) {
          console.log(`\n🚀 Attempting to find gaps after ${skipDuplicatePages} pages of duplicates...`);
          
          // Load all saved article IDs if we haven't already
          if (!savedArticleIds) {
            console.log(`   Loading saved article IDs to find gaps...`);
            const articleDirs = await fs.promises.readdir(ARTICLES_DIR).catch(() => []);
            savedArticleIds = new Set(articleDirs.filter(dir => /^\d+$/.test(dir)));
            console.log(`   Found ${savedArticleIds.size} saved articles`);
          }
          
          // Get the current position from the cursor
          try {
            const decodedCursor = Buffer.from(cursor, 'base64').toString('utf-8');
            console.log(`   Current cursor: ${decodedCursor}`);
            
            const parts = decodedCursor.split('_*_');
            if (parts.length === 2) {
              const currentArticleId = parseInt(parts[0]);
              const timestamp = parts[1];
              
              // Convert saved IDs to numbers and sort them
              const sortedIds = Array.from(savedArticleIds)
                .map(id => parseInt(id))
                .filter(id => !isNaN(id))
                .sort((a, b) => b - a); // Sort descending (newest first)
              
              console.log(`   Current article ID from cursor: ${currentArticleId}`);
              
              // Since we can't create synthetic cursors, we need different strategies
              
              // Strategy 1: Switch to ASC order to fetch from the oldest end
              if (variables.sort.sortOrder === "DESC") {
                console.log(`   Switching to ASC order to fetch from oldest articles`);
                variables.sort.sortOrder = "ASC";
                cursor = null; // Start from the beginning with ASC
                skipDuplicatePages = 0;
              } else if (variables.sort.sortOrder === "ASC") {
                // We're already in ASC and still hitting duplicates
                // Strategy 2: Try small page sizes to quickly skip through duplicates
                if (variables.pagination.first === ARTICLES_PER_REQUEST) {
                  console.log(`   Reducing page size to 50 to quickly skip through duplicates`);
                  variables.pagination.first = 50;
                  skipDuplicatePages = 0;
                } else if (variables.pagination.first === 50) {
                  // Even with small pages we're hitting duplicates
                  console.log(`   Reducing page size further to 10 for faster skipping`);
                  variables.pagination.first = 10;
                  skipDuplicatePages = 0;
                } else {
                  // We've tried everything, go back to DESC with normal pagination
                  console.log(`   Exhausted skip strategies. Returning to DESC order with normal pagination.`);
                  variables.sort.sortOrder = "DESC";
                  variables.pagination.first = ARTICLES_PER_REQUEST;
                  cursor = pageInfo.endCursor; // Continue from where we are
                  skipDuplicatePages = 0;
                }
              }
              
              skipDuplicatePages = 0; // Reset counter
            }
          } catch (err) {
            console.log(`   Error processing cursor: ${err}`);
            // Fallback: switch sort order
            const currentOrder = variables.sort.sortOrder;
            const newOrder = currentOrder === "DESC" ? "ASC" : "DESC";
            console.log(`   Switching from ${currentOrder} to ${newOrder} order`);
            variables.sort.sortOrder = newOrder;
            cursor = null;
            skipDuplicatePages = 0;
          }
        }
      } else if (savedNew > 0) {
        // Reset the counter when we find new articles
        skipDuplicatePages = 0;
        // Clear the cache as we have new articles
        savedArticleIds = null;
        
        // If we were in reduced page size mode, go back to normal
        if (variables.pagination.first !== ARTICLES_PER_REQUEST) {
          console.log(`   Found ${savedNew} new articles! Resuming normal page size.`);
          variables.pagination.first = ARTICLES_PER_REQUEST;
        }
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
  
  // Get actual count of articles on disk
  const finalArticleIds = await exportStore.getSessionArticleIds(sessionId);
  const finalCount = finalArticleIds.length;
  
  // Final summary
  console.log('\n📊 Summary:');
  console.log(`Total unique articles saved: ${finalCount}`);
  console.log(`Articles saved to: ${ARTICLES_DIR}`);
  
  // Update final status with actual count from disk
  const finalStatus = await shouldStop() ? 'stopped' : 'completed';
  await exportStore.updateFetchTask(sessionId, {
    status: finalStatus,
    count: finalCount,  // Use actual count from disk
    total: finalCount,  // Use actual count from disk
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