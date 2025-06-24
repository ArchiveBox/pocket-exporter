#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { getHeaders, getGraphQLEndpoint, extractReaderSlug, handleRateLimit, respectRateLimit, isRateLimitResponse, isAuthError, getCurrentBackoff, increaseBackoff, resetBackoff } = require('./helpers');

const ARTICLES_DIR = path.join(__dirname, 'articles');

const query = `
  query GetSavedItemBySlug($id: ID!) {
    readerSlug(slug: $id) {
      fallbackPage {
        ... on ReaderInterstitial {
          itemCard {
            ... on PocketMetadata {
              item {
                ...ItemDetails
              }
            }
          }
        }
      }
      savedItem {
        ...SavedItemDetails
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
        item {
          ...ItemDetails
          ... on Item {
            article
            relatedAfterArticle(count: 3) {
              corpusRecommendationId: id
              corpusItem {
                thumbnail: imageUrl
                publisher
                title
                externalUrl: url
                saveUrl: url
                id
                excerpt
              }
            }
          }
        }
      }
      slug
    }
  }
  
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
`;

async function makeGraphQLRequest(readerSlug) {
  const postData = JSON.stringify({
    query: query,
    operationName: "GetReaderItem",
    variables: { id: readerSlug }
  });

  const headers = getHeaders({
    'content-length': Buffer.byteLength(postData),
    'referer': `https://getpocket.com/read/${readerSlug}`
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

async function processArticle(folder, retryAttempt = 0) {
  const articleDir = path.join(ARTICLES_DIR, folder);
  const indexPath = path.join(articleDir, 'index.json');
  const articlePath = path.join(articleDir, 'article.html');

  // Skip if article.html already exists
  if (fs.existsSync(articlePath)) {
    return { status: 'skipped', folder };
  }

  if (!fs.existsSync(indexPath)) {
    console.warn(`No index.json found in ${folder}`);
    return { status: 'error', folder, error: 'No index.json found' };
  }

  try {
    // Read the index.json to get readerSlug
    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const readerSlug = extractReaderSlug(indexData) || folder;

    // Respect rate limits
    await respectRateLimit();
    
    console.log(`Downloading content for ./articles/${readerSlug}...`);
    const response = await makeGraphQLRequest(readerSlug);

    // Check for rate limit response
    if (isRateLimitResponse(response)) {
      if (retryAttempt < 100) {
        await handleRateLimit({ code: '161' });
        return processArticle(folder, retryAttempt + 1);
      } else {
        console.error(`Max retries reached for ${folder}`);
        return { status: 'error', folder, error: 'Rate limit max retries' };
      }
    }

    // Check if we got an empty response (common during rate limiting)
    if (!response.data || !response.data.readerSlug) {
      console.warn(`Empty response for ./articles/${readerSlug} - likely rate limited`);
      if (retryAttempt < 100) {
        await handleRateLimit({ code: '161' });
        return processArticle(folder, retryAttempt + 1);
      } else {
        return { status: 'error', folder, error: 'Rate limit max retries' };
      }
    }
    
    // Check if savedItem exists
    if (!response.data?.readerSlug?.savedItem) {
      console.warn(`Article not in saved items: ./articles/${readerSlug}`);
      
      // Check if it's in fallbackPage and if it's not parseable
      const fallbackItem = response.data?.readerSlug?.fallbackPage?.itemCard?.item;
      if (fallbackItem && fallbackItem.isArticle === false) {
        console.warn(`Article not parseable by Pocket (isArticle=false): ${fallbackItem.givenUrl || fallbackItem.resolvedUrl}`);
      }
      
      return { status: 'error', folder, error: 'Article not saved or not parseable' };
    }
    
    // Check if article content exists and is not null
    const article = response.data?.readerSlug?.savedItem?.item?.article;
    if (article && article !== null) {
      fs.writeFileSync(articlePath, article);
      console.log(`✓ Downloaded: ${folder}`);
      return { status: 'downloaded', folder };
    } else {
      // Check if this is because Pocket couldn't parse the article
      const item = response.data?.readerSlug?.savedItem?.item;
      if (item && item.isArticle === false) {
        const url = item.givenUrl || item.resolvedUrl;
        console.warn(`Article not parseable by Pocket (isArticle=false): ${url}`);
        return { status: 'error', folder, error: 'Article not parseable by Pocket' };
      }
      
      console.warn(`No article content found for ./articles/${readerSlug}`);
      console.log('Full response:', JSON.stringify(response, null, 2));
      return { status: 'error', folder, error: 'No article content found' };
    }
  } catch (error) {
    // Check if it's a rate limit error or HTML response (rate limit page)
    const isRateLimitError = error.message.includes('Unexpected token') || 
                            error.message.includes('too many requests') ||
                            error.code === '161';
    
    if (isRateLimitError || await handleRateLimit(error)) {
      if (retryAttempt < 100) {
        return processArticle(folder, retryAttempt + 1);
      } else {
        // Max retries reached, return special rate limit error
        return { status: 'error', folder, error: 'Rate limit max retries' };
      }
    }
    
    console.error(`Error processing ${folder}:`, error.message);
    return { status: 'error', folder, error: error.message };
  }
}

// Track global rate limit state
let isRateLimited = false;
let rateLimitEndTime = 0;

async function downloadArticleContent() {
  console.log('Starting to download article content...');
  
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.error('Articles directory not found. Run get_all_articles.js first.');
    return;
  }

  const folders = fs.readdirSync(ARTICLES_DIR).filter(f => {
    return fs.statSync(path.join(ARTICLES_DIR, f)).isDirectory();
  });

  console.log(`Found ${folders.length} article folders`);

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;
  let unparseable = 0;

  // Process in batches with concurrency limit
  let concurrencyLimit = 3;
  let consecutiveErrors = 0;
  
  for (let i = 0; i < folders.length; ) {
    // Check if we're still rate limited
    if (isRateLimited && Date.now() < rateLimitEndTime) {
      const waitTime = Math.ceil((rateLimitEndTime - Date.now()) / 1000);
      console.log(`\n⏸️  Waiting ${waitTime} seconds for rate limit to expire...`);
      await new Promise(resolve => setTimeout(resolve, Math.min(waitTime * 1000, 60000)));
      // Reset the flag after waiting
      if (Date.now() >= rateLimitEndTime) {
        isRateLimited = false;
      }
      continue;
    }
    
    const batch = folders.slice(i, i + concurrencyLimit);
    const progress = Math.min(i + concurrencyLimit, folders.length);
    
    console.log(`\nProcessing batch ${Math.floor(i/concurrencyLimit) + 1} (${i + 1}-${progress} of ${folders.length})...`);
    
    // Process batch in parallel
    const results = await Promise.all(
      batch.map(folder => processArticle(folder))
    );
    
    // Count results and check for errors
    let batchErrors = 0;
    let rateLimitErrors = 0;
    let rateLimitDetected = false;
    let noContentErrors = 0;
    results.forEach(result => {
      if (result.status === 'downloaded') {
        downloaded++;
        consecutiveErrors = 0;
        // Reset backoff on successful download
        resetBackoff();
      } else if (result.status === 'skipped') {
        skipped++;
      } else if (result.status === 'error') {
        errors++;
        batchErrors++;
        if (result.error === 'Rate limit max retries' || result.error?.includes('rate limit')) {
          consecutiveErrors++;
          rateLimitErrors++;
          rateLimitDetected = true;
        } else if (result.error === 'No article content found' || 
                   result.error === 'Article not saved or not parseable' ||
                   result.error === 'Article not parseable by Pocket') {
          if (result.error === 'Article not parseable by Pocket' || 
              result.error === 'Article not saved or not parseable') {
            unparseable++;
          }
          noContentErrors++;
          // Only count real missing content as consecutive errors, not unparseable articles
          if (result.error === 'No article content found') {
            consecutiveErrors++;
          }
        }
      }
    });
    
    // Only consider it a rate limit if we have many "No article content found" errors
    // and they're not just unparseable articles
    if (noContentErrors > 5 && noContentErrors === batchErrors && batchErrors >= batch.length - skipped) {
      console.log(`⚠️  Multiple "No article content found" errors - might be rate limited`);
      // Don't automatically assume rate limit for unparseable articles
      rateLimitDetected = false;
    }
    
    // If we got rate limited, pause processing
    if (rateLimitDetected || rateLimitErrors > 0) {
      isRateLimited = true;
      // Increase backoff time exponentially
      const backoffTime = increaseBackoff();
      rateLimitEndTime = Date.now() + backoffTime;
      console.log(`\n🛑 Rate limit detected. Pausing batch processing for ${Math.round(backoffTime/1000)} seconds (${Math.round(backoffTime/60000)} minutes)...`);
      // Wait immediately before continuing the loop
      await new Promise(resolve => setTimeout(resolve, Math.min(backoffTime, 60000)));
      continue; // Don't advance to next batch
    }
    
    // Only advance if we didn't hit rate limits
    if (!isRateLimited) {
      // Adjust concurrency based on errors
      if (batchErrors > 0 && batchErrors === batch.length) {
        // All requests in batch failed, likely rate limited
        concurrencyLimit = Math.max(1, Math.floor(concurrencyLimit / 2));
        console.log(`⚠️  Reducing concurrency to ${concurrencyLimit} due to errors`);
        // Force a pause to avoid overwhelming the API
        isRateLimited = true;
        const backoffTime = increaseBackoff();
        rateLimitEndTime = Date.now() + backoffTime;
        console.log(`⚠️  All requests failed, pausing for ${Math.round(backoffTime/1000)} seconds...`);
        continue;
      } else if (consecutiveErrors > 5) {
        // Too many consecutive errors, pause longer
        console.log(`⚠️  Too many errors, pausing for 30 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
        consecutiveErrors = 0;
      }
      
      // Move to next batch only if not rate limited
      i += batch.length;
      
      // Rate limiting between batches
      if (i < folders.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  console.log(`\nCompleted!`);
  console.log(`Articles downloaded: ${downloaded}`);
  console.log(`Articles skipped (already exist): ${skipped}`);
  console.log(`Articles unparseable by Pocket: ${unparseable}`);
  console.log(`Total errors: ${errors}`);
}

// Run the script
downloadArticleContent().catch(console.error);
