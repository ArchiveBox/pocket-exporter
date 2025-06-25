import fs from 'fs';
import path from 'path';
import { Article } from '@/types/article';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { exportStore } from '@/lib/export-store';

interface DownloadQueue {
  sessionId: string;
  articles: Array<{
    article: Article;
    status: 'pending' | 'downloading' | 'completed' | 'error';
    error?: string;
  }>;
  concurrency: number;
  activeDownloads: number;
  stopped?: boolean;
}

const downloadQueues: Map<string, DownloadQueue> = new Map();

import { 
  getHeaders, 
  getGraphQLEndpoint, 
  extractReaderSlug, 
  handleRateLimit, 
  respectRateLimit, 
  isRateLimitResponse, 
  isAuthError, 
  getCurrentBackoff, 
  increaseBackoff, 
  resetBackoff, 
  buildGraphQLQuery, 
  getArticleDir, 
  getArticleHtmlPath, 
  isArticleDownloaded, 
  makeGraphQLRequest 
} from './helpers';

// Track global rate limit state (shared with download_article_content.js)
let isRateLimited = false;
let rateLimitEndTime = 0;

const query = buildGraphQLQuery(`
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
`, ['SavedItemDetails', 'ItemDetails']);

function getProtocol(url: string) {
  return url.startsWith('https://') ? https : http;
}

function getImageFilename(url: string, index: number): string {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const filename = path.basename(pathname);
    
    // If filename has no extension or is empty, create one
    if (!filename || !filename.includes('.')) {
      return `image_${index}.jpg`;
    }
    
    // Sanitize filename
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  } catch (e) {
    return `image_${index}.jpg`;
  }
}

async function downloadFile(url: string, destPath: string, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = getProtocol(url);
    
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: timeoutMs
    };

    // Use a temp file first to ensure we only keep complete downloads
    const tempPath = destPath + '.tmp';
    const file = fs.createWriteStream(tempPath);
    let downloadTimeout: NodeJS.Timeout;
    let timedOut = false;
    
    // Set up cleanup function
    const cleanup = () => {
      clearTimeout(downloadTimeout);
      file.close();
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    };
    
    // Set up timeout
    const cleanupAndReject = (error: Error) => {
      timedOut = true;
      request.destroy();
      cleanup();
      reject(error);
    };
    
    downloadTimeout = setTimeout(() => {
      cleanupAndReject(new Error(`Download timeout after ${timeoutMs/1000} seconds`));
    }, timeoutMs);
    
    const request = protocol.get(options, (response) => {
      if (timedOut) return;
      
      // Handle redirects
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        clearTimeout(downloadTimeout);
        cleanup();
        return downloadFile(response.headers.location, destPath, timeoutMs).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        cleanupAndReject(new Error(`Failed to download: ${response.statusCode} ${url}`));
        return;
      }

      response.pipe(file);
      
      file.on('finish', () => {
        if (!timedOut) {
          clearTimeout(downloadTimeout);
          file.close(() => {
            // Only move the file if download completed successfully
            try {
              fs.renameSync(tempPath, destPath);
              resolve();
            } catch (err: any) {
              cleanup();
              reject(err);
            }
          });
        }
      });
    });

    request.on('error', (err) => {
      if (!timedOut) {
        cleanupAndReject(err);
      }
    });
    
    request.on('timeout', () => {
      if (!timedOut) {
        cleanupAndReject(new Error('Request timeout'));
      }
    });

    file.on('error', (err) => {
      if (!timedOut) {
        cleanupAndReject(err);
      }
    });
  });
}

async function downloadWithTimeout(url: string, destPath: string, timeout = 20000, fallbackUrls: string[] = []): Promise<{ status: string; url?: string; fallback?: boolean; error?: string }> {
  // Try primary URL first
  try {
    // Add rate limiting for getpocket.com URLs
    if (url.includes('getpocket.com') || url.includes('pocket-image-cache.com')) {
      await respectRateLimit();
    }
    
    await downloadFile(url, destPath, timeout);
    resetBackoff(); // Reset on successful download
    return { status: 'downloaded', url };
  } catch (error: any) {
    // Check if it's a rate limit error for pocket URLs
    if ((url.includes('getpocket.com') || url.includes('pocket-image-cache.com')) && 
        (error.message.includes('429') || error.message.includes('403'))) {
      await handleRateLimit(error);
    }
    
    // Try fallback URLs if available
    if (fallbackUrls && fallbackUrls.length > 0) {
      for (const fallbackUrl of fallbackUrls) {
        try {
          // Add rate limiting for getpocket.com fallback URLs
          if (fallbackUrl.includes('getpocket.com') || fallbackUrl.includes('pocket-image-cache.com')) {
            await respectRateLimit();
          }
          
          await downloadFile(fallbackUrl, destPath, timeout);
          resetBackoff(); // Reset on successful download
          return { status: 'downloaded', url: fallbackUrl, fallback: true };
        } catch (fallbackError: any) {
          // Check if it's a rate limit error for pocket fallback URLs
          if ((fallbackUrl.includes('getpocket.com') || fallbackUrl.includes('pocket-image-cache.com')) && 
              (fallbackError.message.includes('429') || fallbackError.message.includes('403'))) {
            await handleRateLimit(fallbackError);
          }
          // Continue to next fallback
        }
      }
    }
    
    // All attempts failed
    return { status: 'error', error: error.message, url };
  }
}

// Helper function to check if downloads should stop
function shouldStopDownload(sessionId: string): boolean {
  const session = exportStore.getSession(sessionId);
  return session?.currentDownloadTask?.status === 'stopped';
}

// Helper function to download images for an article
async function downloadArticleImages(sessionId: string, article: Article, savedItem: any): Promise<void> {
  const articlesDir = getArticleDir(sessionId, article.savedId);
  
  if (!savedItem?.item) {
    return;
  }
  
  const item = savedItem.item;
  const imageMap = new Map<string, { primary: string; fallbacks: string[]; type: string; index?: number }>();
  
  // Build a map of cached URLs
  const cachedUrlMap = new Map<string, string[]>();
  
  // Collect cached URLs from preview
  if (item?.preview?.image?.url && item?.preview?.image?.cachedImages) {
    const primaryUrl = item.preview.image.url;
    const cachedUrls = item.preview.image.cachedImages.map((img: any) => img.url).filter(Boolean);
    if (cachedUrls.length > 0) {
      cachedUrlMap.set(primaryUrl, cachedUrls);
    }
  }
  
  // Process top image
  if (item?.topImageUrl) {
    const fallbacks = cachedUrlMap.get(item.topImageUrl) || [];
    imageMap.set('top', { 
      primary: item.topImageUrl, 
      fallbacks, 
      type: 'top' 
    });
  }
  
  // Process content images
  if (item?.images && Array.isArray(item.images)) {
    item.images.forEach((img: any, idx: number) => {
      if (img.src) {
        const fallbacks = cachedUrlMap.get(img.src) || [];
        imageMap.set(`content_${idx}`, {
          primary: img.src,
          fallbacks,
          type: 'content',
          index: idx
        });
      }
    });
  }
  
  // Process preview image
  if (item?.preview?.image?.url) {
    const previewUrl = item.preview.image.url;
    const cachedUrls = cachedUrlMap.get(previewUrl) || [];
    
    imageMap.set('preview', {
      primary: previewUrl,
      fallbacks: cachedUrls,
      type: 'preview'
    });
  }

  if (imageMap.size === 0) {
    return;
  }

  console.log(`  ⬇️  Downloading ${imageMap.size} images for article ${article.savedId}...`);
  let downloadedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Download all images
  for (const [key, imgData] of imageMap.entries()) {
    // Check if downloads were stopped
    if (shouldStopDownload(sessionId)) {
      console.log('Image downloads stopped by user');
      break;
    }
    
    const { primary, fallbacks, type, index = 0 } = imgData;
    
    // Generate filename based on type and index
    let filename: string;
    if (type === 'top') {
      filename = 'top_image' + path.extname(getImageFilename(primary, 0));
    } else if (type === 'preview') {
      filename = 'preview_image' + path.extname(getImageFilename(primary, 0));
    } else {
      filename = getImageFilename(primary, index);
    }
    
    const destPath = path.join(articlesDir, filename);

    // Skip if already exists with non-zero size
    if (fs.existsSync(destPath)) {
      const stats = fs.statSync(destPath);
      if (stats.size > 0) {
        skippedCount++;
        continue;
      }
      // Remove empty files and re-download
      fs.unlinkSync(destPath);
    }

    // Download with fallbacks
    const result = await downloadWithTimeout(primary, destPath, 20000, fallbacks);
    if (result.status === 'downloaded') {
      downloadedCount++;
    } else {
      errorCount++;
    }
  }

  if (downloadedCount > 0 || errorCount > 0) {
    console.log(`  ✓ Images: ${downloadedCount} downloaded, ${skippedCount} skipped, ${errorCount} errors`);
  }
}

// Fetch article data from GraphQL (used for both HTML and images)
async function fetchArticleData(
  sessionId: string,
  article: Article,
  auth: { cookieString: string; headers: Record<string, string> },
  retryAttempt = 0
): Promise<any> {
  // Use the extractReaderSlug helper to get the correct slug format
  const readerSlug = extractReaderSlug(article);
  
  if (!readerSlug) {
    console.log(`Skipping article ${article.savedId} - no readerSlug available`);
    throw new Error('No readerSlug available');
  }
  
  // Respect rate limits
  await respectRateLimit();
  
  const response = await makeArticleGraphQLRequest(readerSlug, auth);

  // Check for rate limit response
  if (isRateLimitResponse(response)) {
    if (retryAttempt < 100) {
      await handleRateLimit({ code: '161' });
      return fetchArticleData(sessionId, article, auth, retryAttempt + 1);
    } else {
      throw new Error('Rate limit max retries');
    }
  }

  // Check if we got an empty response
  if (!response.data || !response.data.readerSlug) {
    console.warn(`Empty response for ${article.savedId} - likely rate limited`);
    if (retryAttempt < 100) {
      await handleRateLimit({ code: '161' });
      return fetchArticleData(sessionId, article, auth, retryAttempt + 1);
    } else {
      throw new Error('Rate limit max retries');
    }
  }
  
  return response.data?.readerSlug;
}

async function makeArticleGraphQLRequest(readerSlug: string, auth: { cookieString: string; headers: Record<string, string> }) {
  const variables = { id: readerSlug };
  const additionalHeaders = {
    'referer': `https://getpocket.com/read/${readerSlug}`,
    ...auth.headers,
    'cookie': auth.cookieString
  };
  
  return makeGraphQLRequest(query, variables, "GetReaderItem", additionalHeaders);
}

// Download article content (HTML and images)
async function downloadArticleContent(
  sessionId: string,
  article: Article,
  auth: { cookieString: string; headers: Record<string, string> },
  onlyImages = false
): Promise<void> {
  // Check if downloads were stopped
  if (shouldStopDownload(sessionId)) {
    throw new Error('Stopped by user');
  }
  
  const articlesDir = getArticleDir(sessionId, article.savedId);
  const articleHtmlPath = getArticleHtmlPath(sessionId, article.savedId);
  const articleExists = isArticleDownloaded(sessionId, article.savedId);
  
  // If only downloading images, check if article exists first
  if (onlyImages && !articleExists) {
    return;
  }
  
  // If article already exists and we're not only checking images, skip
  if (!onlyImages && articleExists) {
    console.log(`Article ${article.savedId} already downloaded, checking for missing images...`);
    // Still check for missing images
    return downloadArticleContent(sessionId, article, auth, true);
  }

  try {
    const logPrefix = onlyImages 
      ? `Checking for missing images in ./sessions/${sessionId}/articles/${article.savedId}...`
      : `Downloading content for ./sessions/${sessionId}/articles/${article.savedId}...`;
    
    console.log(logPrefix);
    
    // Fetch article data from GraphQL
    const readerSlugData = await fetchArticleData(sessionId, article, auth);
    
    // Check if savedItem exists
    if (!readerSlugData?.savedItem) {
      console.warn(`Article not in saved items: ${article.savedId}`);
      
      // Check if it's in fallbackPage and if it's not parseable
      const fallbackItem = readerSlugData?.fallbackPage?.itemCard?.item;
      if (fallbackItem && fallbackItem.isArticle === false) {
        console.warn(`Article not parseable by Pocket (isArticle=false): ${fallbackItem.givenUrl || fallbackItem.resolvedUrl}`);
      }
      
      throw new Error('Article not saved or not parseable');
    }
    
    // Download HTML if not only checking images
    if (!onlyImages) {
      const articleContent = readerSlugData?.savedItem?.item?.article;
      if (articleContent && articleContent !== null) {
        // Ensure directory exists
        if (!fs.existsSync(articlesDir)) {
          fs.mkdirSync(articlesDir, { recursive: true });
        }
        
        // Check again if downloads were stopped before writing
        if (shouldStopDownload(sessionId)) {
          throw new Error('Stopped by user');
        }
        
        // Save the article HTML
        fs.writeFileSync(articleHtmlPath, articleContent);
        console.log(`✓ Downloaded article.html for: ${article.savedId}`);
        
        // Update the article's index.json with the full data from the detail response
        const articleIndexPath = path.join(articlesDir, 'index.json');
        const fullArticleData = { ...readerSlugData.savedItem };
        
        // Remove the article HTML content since we save it separately
        if (fullArticleData.item?.article) {
          delete fullArticleData.item.article;
        }
        
        // Remove related articles to save space
        if (fullArticleData.item?.relatedAfterArticle) {
          delete fullArticleData.item.relatedAfterArticle;
        }
        
        fs.writeFileSync(articleIndexPath, JSON.stringify(fullArticleData, null, 2));
        console.log(`✓ Updated article metadata for: ${article.savedId}`);
        
        // Update the queue status immediately to completed
        const queue = downloadQueues.get(sessionId);
        if (queue) {
          const queueItem = queue.articles.find(item => item.article.savedId === article.savedId);
          if (queueItem) {
            queueItem.status = 'completed';
          }
        }
      } else {
        // Check if this is because Pocket couldn't parse the article
        const item = readerSlugData?.savedItem?.item;
        if (item && item.isArticle === false) {
          const url = item.givenUrl || item.resolvedUrl;
          console.warn(`Article not parseable by Pocket (isArticle=false): ${url}`);
          throw new Error('Article not parseable by Pocket');
        }
        
        console.warn(`No article content found for ./sessions/${sessionId}/articles/${article.savedId}`);
        throw new Error('No article content found');
      }
    }
    
    // Check if downloads were stopped before downloading images
    if (shouldStopDownload(sessionId)) {
      throw new Error('Stopped by user');
    }
    
    // Download images
    await downloadArticleImages(sessionId, article, readerSlugData?.savedItem);
  } catch (error: any) {
    // Check if it's a rate limit error or HTML response (rate limit page)
    const isRateLimitError = error.message?.includes('Unexpected token') || 
                            error.message?.includes('too many requests') ||
                            error.code === '161' ||
                            error.message === 'Rate limit max retries';
    
    if (isRateLimitError) {
      throw error; // Let the caller handle rate limit retries
    }
    
    console.error(`Error processing ${article.savedId}:`, error.message);
    throw error;
  }
}

async function processDownloadQueue(sessionId: string, auth: { cookieString: string; headers: Record<string, string> }, updateSession: boolean = true): Promise<void> {
  const queue = downloadQueues.get(sessionId);
  if (!queue) return;

  // Check if we're still rate limited globally
  if (isRateLimited && Date.now() < rateLimitEndTime) {
    const waitTime = Math.ceil((rateLimitEndTime - Date.now()) / 1000);
    console.log(`⏸️  Waiting ${waitTime} seconds for rate limit to expire...`);
    setTimeout(() => {
      if (Date.now() >= rateLimitEndTime) {
        isRateLimited = false;
      }
      processDownloadQueue(sessionId, auth, updateSession);
    }, Math.min(waitTime * 1000, 60000));
    return;
  }

  while (queue.activeDownloads < queue.concurrency) {
    // Check session status to see if downloads were stopped
    const session = exportStore.getSession(sessionId);
    if (session?.currentDownloadTask?.status === 'stopped') {
      console.log('Downloads stopped by user');
      // Mark all pending items as stopped
      queue.articles.forEach(item => {
        if (item.status === 'pending' || item.status === 'downloading') {
          item.status = 'error';
          item.error = 'Stopped by user';
        }
      });
      break;
    }
    
    // Find the first pending article (maintains order from the array)
    const pendingIndex = queue.articles.findIndex(item => item.status === 'pending');
    if (pendingIndex === -1) break;
    
    const pending = queue.articles[pendingIndex];

    pending.status = 'downloading';
    queue.activeDownloads++;

    // Update current download item in session
    if (updateSession) {
      exportStore.updateDownloadTask(sessionId, {
        currentID: pending.article.savedId
      });
    }

    downloadArticleContent(sessionId, pending.article, auth)
      .then(() => {
        pending.status = 'completed';
        resetBackoff(); // Reset backoff on successful download
        
        // Update download count
        if (updateSession) {
          const completedCount = queue.articles.filter(item => item.status === 'completed').length;
          exportStore.updateDownloadTask(sessionId, {
            count: completedCount
          });
        }
      })
      .catch((error) => {
        pending.status = 'error';
        pending.error = error.message;
        
        // Check if it's a rate limit error
        if (error.message === 'Rate limit max retries' || error.message?.includes('rate limit')) {
          isRateLimited = true;
          const backoffTime = increaseBackoff();
          rateLimitEndTime = Date.now() + backoffTime;
          console.log(`🛑 Rate limit detected. Pausing downloads for ${Math.round(backoffTime/1000)} seconds...`);
          
          // Update rate limit status in session
          if (updateSession) {
            exportStore.updateDownloadTask(sessionId, {
              rateLimitedAt: new Date(),
              rateLimitRetryAfter: Math.round(backoffTime / 1000)
            });
          }
        }
      })
      .finally(() => {
        queue.activeDownloads--;
        
        // Check if all downloads are complete
        const pendingCount = queue.articles.filter(item => item.status === 'pending').length;
        const downloadingCount = queue.articles.filter(item => item.status === 'downloading').length;
        
        if (pendingCount === 0 && downloadingCount === 0) {
          // All downloads complete
          const completedCount = queue.articles.filter(item => item.status === 'completed').length;
          const errorCount = queue.articles.filter(item => item.status === 'error').length;
          
          if (updateSession) {
            exportStore.updateDownloadTask(sessionId, {
              status: errorCount > 0 && completedCount === 0 ? 'error' : 'completed',
              endedAt: new Date(),
              currentID: undefined
            });
          }
        }
        
        // Process next item
        processDownloadQueue(sessionId, auth, updateSession);
      });
  }
}

export function startArticleDownloads(
  sessionId: string,
  articles: Article[],
  auth: { cookieString: string; headers: Record<string, string> },
  updateSession: boolean = true
): void {
  let queue = downloadQueues.get(sessionId);
  
  if (!queue) {
    queue = {
      sessionId,
      articles: [],
      concurrency: 3, // Download 3 articles in parallel
      activeDownloads: 0
    };
    downloadQueues.set(sessionId, queue);
  }

  // Clear existing queue to ensure we process in the order provided
  queue.articles = [];

  // Add articles to queue in the order they appear in the array (newest to oldest from UI)
  articles.forEach(article => {
    const isDownloaded = isArticleDownloaded(sessionId, article.savedId);
    
    if (isDownloaded) {
      // Add to queue as completed, but mark for image check
      queue!.articles.push({
        article,
        status: 'completed',
      });
    } else {
      // Add as pending for full download
      queue!.articles.push({
        article,
        status: 'pending',
      });
    }
  });

  // Update download task status in session only if requested
  if (updateSession) {
    exportStore.updateDownloadTask(sessionId, {
      status: 'running',
      startedAt: new Date(),
      count: 0,
      total: articles.length,
      pid: process.pid
    });
  }

  // Start processing the queue
  processDownloadQueue(sessionId, auth, updateSession);
  
  // Also start a separate process to check for missing images in completed articles
  processExistingArticlesForImages(sessionId, articles, auth);
}

// Process missing images for already downloaded articles
async function processExistingArticlesForImages(
  sessionId: string,
  articles: Article[],
  auth: { cookieString: string; headers: Record<string, string> }
): Promise<void> {
  // Filter articles that have HTML but might be missing images
  const articlesWithHtml = articles.filter(article => 
    isArticleDownloaded(sessionId, article.savedId)
  );
  
  if (articlesWithHtml.length === 0) {
    return;
  }
  
  console.log(`Checking ${articlesWithHtml.length} downloaded articles for missing images...`);
  
  // Process articles sequentially to avoid overwhelming the API
  for (const article of articlesWithHtml) {
    // Check if downloads were stopped
    if (shouldStopDownload(sessionId)) {
      console.log('Image downloads stopped by user');
      break;
    }
    
    try {
      await downloadArticleContent(sessionId, article, auth, true); // onlyImages = true
    } catch (error: any) {
      // Handle rate limit errors
      if (error.message === 'Rate limit max retries' || error.message?.includes('rate limit')) {
        console.log('Rate limit reached while checking images, stopping...');
        break;
      }
      console.error(`Error checking images for article ${article.savedId}:`, error.message);
      // Continue with next article even if one fails
    }
  }
}

export function stopDownloads(sessionId: string): void {
  // Update session status - this will be picked up by the download process
  exportStore.updateDownloadTask(sessionId, {
    status: 'stopped',
    endedAt: new Date(),
    currentID: undefined
  });
  
  // The queue will be cleaned up by the processDownloadQueue function
  // when it checks the session status
}

// Download a single article without updating session task status
export async function downloadSingleArticle(
  sessionId: string,
  article: Article,
  auth: { cookieString: string; headers: Record<string, string> }
): Promise<{ success: boolean; error?: string }> {
  try {
    // Download article content directly without going through the queue
    await downloadArticleContent(sessionId, article, auth);
    return { success: true };
  } catch (error: any) {
    console.error(`Error downloading article ${article.savedId}:`, error.message);
    return { success: false, error: error.message };
  }
}

export function getDownloadStatus(sessionId: string, articles?: any[]): {
  total: number;
  completed: number;
  downloading: number;
  errors: number;
  articleStatus: Record<string, 'pending' | 'downloading' | 'completed' | 'error'>;
} {
  const articleStatus: Record<string, 'pending' | 'downloading' | 'completed' | 'error'> = {};
  
  // Get status from the active download queue if it exists
  const queue = downloadQueues.get(sessionId);
  let downloading = 0;
  let errors = 0;
  
  if (queue) {
    queue.articles.forEach(item => {
      articleStatus[item.article.savedId] = item.status;
      if (item.status === 'downloading') downloading++;
      if (item.status === 'error') errors++;
    });
  }
  
  // Check filesystem for all articles (not just ones in queue)
  if (articles && articles.length > 0) {
    articles.forEach((article: Article) => {
      // Skip if already tracked by queue
      if (articleStatus[article.savedId]) return;
      
      // Check if article.html exists
      const articleHtmlPath = getArticleHtmlPath(sessionId, article.savedId);
      if (fs.existsSync(articleHtmlPath)) {
        articleStatus[article.savedId] = 'completed';
      } else {
        articleStatus[article.savedId] = 'pending';
      }
    });
  }
  
  // Count totals
  let completed = 0;
  let total = 0;
  
  Object.values(articleStatus).forEach(status => {
    total++;
    if (status === 'completed') completed++;
  });

  return {
    total,
    completed,
    downloading,
    errors,
    articleStatus
  };
}