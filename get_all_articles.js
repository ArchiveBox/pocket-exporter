#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getHeaders, getGraphQLEndpoint, deepMerge, handleRateLimit, respectRateLimit, isRateLimitResponse, isAuthError, buildGraphQLQuery, GRAPHQL_FRAGMENTS, makeGraphQLRequest } = require('./helpers');

// Parse command line arguments
const args = process.argv.slice(2);
const sessionId = args[0]; // First argument is the session ID
const cursorArg = args.find(arg => arg.startsWith('--cursor='));
const resumeCursor = cursorArg ? cursorArg.split('=')[1] : null;

// Import export store to update session
const { exportStore } = require('./lib/export-store');

const ARTICLES_PER_REQUEST = 1000;

// Show help if requested
if (args.includes('--help') || args.includes('-h') || !sessionId) {
  console.log(`
Usage: node get_all_articles.js <sessionId> [options]

Options:
  --cursor=CURSOR  Resume fetching from a specific cursor position
  --help, -h       Show this help message

The script automatically saves progress and can resume from where it left off.
If interrupted, it will show the cursor to manually resume from.
  `);
  process.exit(0);
}

const SESSION_DIR = path.join(__dirname, 'sessions', sessionId);
const ARTICLES_DIR = path.join(SESSION_DIR, 'articles');
const STATE_FILE = path.join(SESSION_DIR, '.fetch_state.json');

// Create articles directory if it doesn't exist
if (!fs.existsSync(ARTICLES_DIR)) {
  fs.mkdirSync(ARTICLES_DIR, { recursive: true });
}

// Load saved state
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      console.log(`Resuming from cursor: ${state.cursor}`);
      console.log(`Previously fetched: ${state.totalFetched} articles`);
      return state;
    }
  } catch (e) {
    console.error('Error loading state:', e.message);
  }
  return null;
}

// Save state
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Error saving state:', e.message);
  }
}

// Clear state when complete
function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch (e) {
    console.error('Error clearing state:', e.message);
  }
}

// Use the exact query from the curl example
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
                resolvedId
                resolvedUrl
                readerSlug
                domain
                domainMetadata {
                  name
                }
                excerpt
                topImageUrl
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
                authors {
                  id
                  name
                  url
                }
                datePublished
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

async function makeGraphQLRequestWithDebug(variables, debug = false) {
  const additionalHeaders = {
    'referer': 'https://getpocket.com/saves?src=navbar'
  };

  if (debug) {
    const headers = getHeaders(additionalHeaders);
    console.log('\nDebug - Request headers:');
    Object.entries(headers).forEach(([key, value]) => {
      if (key === 'cookie') {
        console.log(`  ${key}: [${value.length} characters]`);
        // Show first few cookies for debugging
        const cookies = value.split('; ').slice(0, 3).join('; ');
        console.log(`    First few cookies: ${cookies}...`);
      } else {
        console.log(`  ${key}: ${value}`);
      }
    });
  }

  return makeGraphQLRequest(query, variables, "getItemsUnread", additionalHeaders);
}

async function getAllArticles() {
  let hasNextPage = true;
  let cursor = null;
  let totalFetched = 0;
  let articlesCreated = 0;
  let articlesUpdated = 0;
  let retryCount = 0;
  const maxRetries = 100;


  // Priority: command line arg > saved state > start from beginning
  if (resumeCursor) {
    cursor = resumeCursor;
    console.log(`Resuming from cursor provided via command line: ${cursor}`);
  } else {
    // Load saved state if resuming
    const savedState = loadState();
    if (savedState) {
      cursor = savedState.cursor;
      totalFetched = savedState.totalFetched || 0;
      articlesCreated = savedState.articlesCreated || 0;
      articlesUpdated = savedState.articlesUpdated || 0;
      console.log('Resuming from saved state...');
    } else {
      console.log('Starting to fetch all articles...');
    }
  }

  while (hasNextPage) {
    const variables = {
      filter: { statuses: ["UNREAD", "ARCHIVED"] },
      sort: { sortBy: "CREATED_AT", sortOrder: "DESC" },
      pagination: { first: ARTICLES_PER_REQUEST }  // Reduced from 1000 to avoid issues
    };
    
    if (cursor) {
      variables.pagination.after = cursor;
    }

    try {
      // Respect rate limits
      await respectRateLimit();
      
      console.log(`\nFetching page ${cursor ? `after cursor ${cursor}` : '(first page)'}...`);
      // Enable debug on first request to see headers
      const response = await makeGraphQLRequestWithDebug(variables, !cursor);
      
      // Always log response if there are errors
      if (response.errors) {
        console.error('\n❌ GraphQL errors in response:', JSON.stringify(response, null, 2));
      }
      
      // Check for authentication error
      if (isAuthError(response)) {
        console.error('\n❌ Authentication error detected. Your session has expired.');
        console.error('Full response:', JSON.stringify(response, null, 2));
        console.error('\nPlease update your cookies:');
        console.error('1. Run: node parse_fetch_to_env.js');
        console.error('2. Copy a fresh fetch request from Pocket');
        break;
      }
      
      // Check for rate limit response
      if (isRateLimitResponse(response)) {
        console.error('Rate limit response:', JSON.stringify(response, null, 2));
        if (retryCount < maxRetries) {
          retryCount++;
          await handleRateLimit({ code: '161' });
          continue; // Retry the same page
        } else {
          console.error('Max retries reached for rate limiting. Stopping.');
          break;
        }
      }
      
      // Reset retry count on successful request
      retryCount = 0;
      
      if (!response.data || !response.data.user || !response.data.user.savedItems) {
        console.error('Invalid response structure:', JSON.stringify(response, null, 2));
        break;
      }

      const savedItems = response.data.user.savedItems;
      const edges = savedItems.edges || [];
      
      console.log(`Fetched ${edges.length} articles`);
      totalFetched += edges.length;

      for (const edge of edges) {
        const article = edge.node;
        const item = article.item || {};
        
        // Use readerSlug if available, otherwise fall back to savedId
        const folderId = item.readerSlug || article.savedId;
        
        if (!folderId) {
          console.warn('Skipping article without ID:', article.title);
          continue;
        }

        const articleDir = path.join(ARTICLES_DIR, folderId);
        const indexPath = path.join(articleDir, 'index.json');

        // Create directory if needed
        if (!fs.existsSync(articleDir)) {
          fs.mkdirSync(articleDir, { recursive: true });
        }

        // Merge article data with item data
        const fullArticle = {
          ...article,
          item: {
            ...item,
            readerSlug: item.readerSlug || folderId
          }
        };

        // If file exists, merge with existing data
        if (fs.existsSync(indexPath)) {
          try {
            const existingData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            // Deep merge, preserving existing data and adding new fields
            const mergedArticle = deepMerge(existingData, fullArticle);
            fs.writeFileSync(indexPath, JSON.stringify(mergedArticle, null, 2));
            articlesUpdated++;
            console.log(`Updated: ${articleDir}`);
          } catch (e) {
            console.error(`Error merging data for ${folderId}:`, e.message);
            // If merge fails, just skip
            articlesUpdated++;
          }
        } else {
          // Save new article data
          fs.writeFileSync(indexPath, JSON.stringify(fullArticle, null, 2));
          articlesCreated++;
          console.log(`Created: ${articleDir}`);
        }
      }

      // Check for next page
      hasNextPage = savedItems.pageInfo.hasNextPage;
      cursor = savedItems.pageInfo.endCursor;
      
      // Save state after each successful page
      if (hasNextPage && cursor) {
        saveState({
          cursor,
          totalFetched,
          articlesCreated,
          articlesUpdated,
          lastSaved: new Date().toISOString()
        });
        console.log(`\nProgress saved. Current cursor: ${cursor}`);
      }
      
      // Rate limiting - wait a bit between requests
      if (hasNextPage) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

    } catch (error) {
      console.error('Error fetching articles:', error);
      
      // Check if it's a rate limit error
      if (await handleRateLimit(error)) {
        if (retryCount < maxRetries) {
          retryCount++;
          continue; // Retry the same page
        }
      }
      
      break;
    }
  }

  // Clear state file on successful completion
  if (!hasNextPage) {
    clearState();
    console.log(`\n✅ Completed! All articles fetched.`);
  } else if (cursor) {
    console.log(`\n⚠️  Script stopped or interrupted.`);
    console.log(`\nTo resume, run:`);
    console.log(`node get_all_articles.js --cursor=${cursor}`);
    console.log(`\nOr simply run 'node get_all_articles.js' to auto-resume from saved state.`);
  }
  
  console.log(`\nStats:`);
  console.log(`  Total articles fetched: ${totalFetched}`);
  console.log(`  Articles created: ${articlesCreated}`);
  console.log(`  Articles updated: ${articlesUpdated}`);
}

// Run the script
getAllArticles().catch(console.error);
