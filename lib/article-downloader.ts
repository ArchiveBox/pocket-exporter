import fs from 'fs';
import path from 'path';
import { Article } from '@/types/article';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { execSync } from 'child_process';
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
  handleRateLimit, 
  respectRateLimit, 
  increaseBackoff, 
  resetBackoff, 
  getArticleDir, 
  getArticleHtmlPath, 
  isArticleDownloaded
} from './helpers';

// Track global rate limit state (shared with download_article_content.js)
let isRateLimited = false;
let rateLimitEndTime = 0;

// No longer using GraphQL to fetch article content - we download original HTML with curl instead

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

// Helper function to get directory size
function getDirectorySize(dirPath: string): number {
  let totalSize = 0;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        totalSize += stats.size;
      }
    }
  } catch (e) {
    // Directory doesn't exist or error reading it
  }
  return totalSize;
}

// Helper function to download images for an article
async function downloadArticleImages(sessionId: string, article: Article, savedItem: any): Promise<void> {
  const articlesDir = getArticleDir(sessionId, article.savedId);
  const MAX_IMAGES_SIZE = 50 * 1024 * 1024; // 50MB limit per article
  
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
  let skippedDueToSize = 0;

  // Download all images
  for (const [key, imgData] of imageMap.entries()) {
    // Check if downloads were stopped
    if (shouldStopDownload(sessionId)) {
      console.log('Image downloads stopped by user');
      break;
    }
    
    // Check current directory size before each download
    const currentDirSize = getDirectorySize(articlesDir);
    if (currentDirSize >= MAX_IMAGES_SIZE) {
      console.log(`  ⚠️  Skipping remaining images - directory size limit reached (${(currentDirSize / 1024 / 1024).toFixed(1)}MB)`);
      skippedDueToSize = imageMap.size - downloadedCount - skippedCount - errorCount;
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

  if (downloadedCount > 0 || errorCount > 0 || skippedDueToSize > 0) {
    const parts = [`  ✓ Images: ${downloadedCount} downloaded`];
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
    if (errorCount > 0) parts.push(`${errorCount} errors`);
    if (skippedDueToSize > 0) parts.push(`${skippedDueToSize} skipped (size limit)`);
    console.log(parts.join(', '));
  }
}

// No longer needed - we're downloading original HTML with curl instead of using GraphQL

// Download article content (original HTML from source URL)
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
  const originalHtmlPath = path.join(articlesDir, 'original.html');
  const articleExists = fs.existsSync(originalHtmlPath);
  
  // If only downloading images, we don't need to do anything for original HTML
  if (onlyImages) {
    return;
  }
  
  // If article already exists, skip
  if (articleExists) {
    console.log(`Original HTML for ${article.savedId} already downloaded`);
    return;
  }

  try {
    console.log(`Downloading original HTML for ./sessions/${sessionId}/articles/${article.savedId}...`);
    
    // Get the article URL
    const articleUrl = article.url || article.item?.givenUrl || article.item?.resolvedUrl;
    if (!articleUrl) {
      console.log(`Skipping ${article.savedId} - no URL available`);
      // Mark as completed since there's nothing to download
      const queue = downloadQueues.get(sessionId);
      if (queue) {
        const queueItem = queue.articles.find(item => item.article.savedId === article.savedId);
        if (queueItem) {
          queueItem.status = 'completed';
        }
      }
      return;
    }
    
    // Ensure directory exists
    if (!fs.existsSync(articlesDir)) {
      fs.mkdirSync(articlesDir, { recursive: true });
    }
    
    // Check again if downloads were stopped before downloading
    if (shouldStopDownload(sessionId)) {
      throw new Error('Stopped by user');
    }
    
    // Use curl to download the original HTML
    try {
      // Use curl with a timeout and user agent to fetch the page
      // Remove -s (silent) flag to see errors
      const curlCommand = `curl -L --max-time 30 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" "${articleUrl}"`;
      const originalHtml = execSync(curlCommand, { 
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        stdio: ['ignore', 'pipe', 'pipe'] // Capture stderr
      });
      
      // Check if we got any content
      if (!originalHtml || originalHtml.trim().length === 0) {
        throw new Error('Empty response from server');
      }
      
      // Save the original HTML
      fs.writeFileSync(originalHtmlPath, originalHtml);
      console.log(`✓ Downloaded original HTML for: ${article.savedId} (${originalHtml.length} bytes)`);
      // Successfully downloaded, now get images
      // Check if we have article metadata locally
      const articleIndexPath = path.join(articlesDir, 'index.json');
      let articleData = null;
      
      if (fs.existsSync(articleIndexPath)) {
        try {
          articleData = JSON.parse(fs.readFileSync(articleIndexPath, 'utf8'));
        } catch (e) {
          console.log(`Failed to parse article metadata for ${article.savedId}`);
        }
      }
      
      // If we have article data with image info, download the images
      if (articleData) {
        await downloadArticleImages(sessionId, article, articleData);
      }
      
      // Update the queue status to completed
      const queue = downloadQueues.get(sessionId);
      if (queue) {
        const queueItem = queue.articles.find(item => item.article.savedId === article.savedId);
        if (queueItem) {
          queueItem.status = 'completed';
        }
      }
    } catch (curlError: any) {
      // Log more details about the error
      const errorMsg = curlError.stderr || curlError.message || 'Unknown error';
      console.error(`❌ Failed to download ${article.savedId} from ${articleUrl}: ${errorMsg}`);
      
      // Mark as error in the queue
      const queue = downloadQueues.get(sessionId);
      if (queue) {
        const queueItem = queue.articles.find(item => item.article.savedId === article.savedId);
        if (queueItem) {
          queueItem.status = 'error';
          queueItem.error = errorMsg;
        }
      }
      
      // Don't return here - we still need to update the queue status
      // The error is already logged and marked in the queue
    }
  } catch (error: any) {
    console.error(`Error processing ${article.savedId}:`, error.message);
    // Mark as error in the queue
    const queue = downloadQueues.get(sessionId);
    if (queue) {
      const queueItem = queue.articles.find(item => item.article.savedId === article.savedId);
      if (queueItem) {
        queueItem.status = 'error';
        queueItem.error = error.message;
      }
    }
    throw error;
  }
}

async function processDownloadQueue(sessionId: string, auth: { cookieString: string; headers: Record<string, string> }, updateSession: boolean = true): Promise<void> {
  const queue = downloadQueues.get(sessionId);
  if (!queue) {
    console.log('No download queue found for session:', sessionId);
    return;
  }

  console.log(`Processing download queue: ${queue.articles.length} articles, ${queue.activeDownloads} active downloads`);

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
        // Check the actual status in the queue (it might have been set to 'error' in downloadArticleContent)
        if (pending.status !== 'error') {
          pending.status = 'completed';
          resetBackoff(); // Reset backoff on successful download
        }
        
        // Update download count (including both completed and errors)
        if (updateSession) {
          const completedCount = queue.articles.filter(item => item.status === 'completed').length;
          const errorCount = queue.articles.filter(item => item.status === 'error').length;
          exportStore.updateDownloadTask(sessionId, {
            count: completedCount + errorCount
          });
        }
      })
      .catch((error) => {
        // Status might already be set to 'error' in downloadArticleContent
        if (pending.status !== 'error') {
          pending.status = 'error';
          pending.error = error.message;
        }
        
        // Update download count including errors
        if (updateSession) {
          const completedCount = queue.articles.filter(item => item.status === 'completed').length;
          const errorCount = queue.articles.filter(item => item.status === 'error').length;
          exportStore.updateDownloadTask(sessionId, {
            count: completedCount + errorCount
          });
        }
        
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
  console.log(`Starting article downloads for session ${sessionId} with ${articles.length} articles`);
  
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
  let pendingCount = 0;
  let completedCount = 0;
  
  articles.forEach(article => {
    // Check specifically for original.html, not article.html
    const originalHtmlPath = path.join(getArticleDir(sessionId, article.savedId), 'original.html');
    const hasOriginalHtml = fs.existsSync(originalHtmlPath);
    
    if (hasOriginalHtml) {
      // Add to queue as completed, but mark for image check
      queue!.articles.push({
        article,
        status: 'completed',
      });
      completedCount++;
    } else {
      // Add as pending for full download
      queue!.articles.push({
        article,
        status: 'pending',
      });
      pendingCount++;
    }
  });
  
  console.log(`Download queue: ${pendingCount} pending, ${completedCount} already completed`);

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
  // Filter articles that have original HTML
  const articlesWithHtml = articles.filter(article => 
    isArticleDownloaded(sessionId, article.savedId)
  );
  
  if (articlesWithHtml.length === 0) {
    return;
  }
  
  console.log(`Checking ${articlesWithHtml.length} downloaded articles for missing images...`);
  
  // Process articles sequentially to avoid overwhelming downloads
  for (const article of articlesWithHtml) {
    // Check if downloads were stopped
    if (shouldStopDownload(sessionId)) {
      console.log('Image downloads stopped by user');
      break;
    }
    
    const articlesDir = getArticleDir(sessionId, article.savedId);
    const articleIndexPath = path.join(articlesDir, 'index.json');
    
    // Load article metadata to get image URLs
    if (fs.existsSync(articleIndexPath)) {
      try {
        const articleData = JSON.parse(fs.readFileSync(articleIndexPath, 'utf8'));
        // Download images from metadata
        await downloadArticleImages(sessionId, article, articleData);
      } catch (error: any) {
        console.error(`Error processing images for article ${article.savedId}:`, error.message);
        // Continue with next article even if one fails
      }
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
): Promise<{ success: boolean; error?: string; alreadyDownloaded?: boolean }> {
  try {
    // Check if article is already downloaded
    if (isArticleDownloaded(sessionId, article.savedId)) {
      console.log(`Article ${article.savedId} already downloaded`);
      // Still check for missing images
      await downloadArticleContent(sessionId, article, auth, true); // onlyImages = true
      return { success: true, alreadyDownloaded: true };
    }
    
    // Download article content directly without going through the queue
    await downloadArticleContent(sessionId, article, auth);
    return { success: true, alreadyDownloaded: false };
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
  
  // Early return if no articles
  if (!articles || articles.length === 0) {
    return {
      total: 0,
      completed: 0,
      downloading: 0,
      errors: 0,
      articleStatus
    };
  }
  
  // Get currently downloading items from the active queue
  const queue = downloadQueues.get(sessionId);
  const currentlyDownloading = new Set<string>();
  
  if (queue) {
    queue.articles.forEach(item => {
      if (item.status === 'downloading') {
        currentlyDownloading.add(item.article.savedId);
      }
    });
  }
  
  let downloading = 0;
  let errors = 0;
  let completed = 0;
  
  // Always check filesystem for accurate status
  // Batch process articles to check filesystem more efficiently
  const articlesDir = path.join(process.cwd(), 'sessions', sessionId, 'articles');
  
  // First, get a set of all article directories that have original.html
  const completedArticles = new Set<string>();
  try {
    // Read all directories at once to minimize filesystem calls
    const articleDirs = fs.readdirSync(articlesDir, { withFileTypes: true });
    
    // Check each directory for original.html
    for (const dir of articleDirs) {
      if (dir.isDirectory()) {
        try {
          const originalHtmlPath = path.join(articlesDir, dir.name, 'original.html');
          const stats = fs.statSync(originalHtmlPath);
          if (stats.size > 0) {
            completedArticles.add(dir.name);
          }
        } catch (e) {
          // File doesn't exist, skip
        }
      }
    }
  } catch (e) {
    // Directory doesn't exist or error reading it
    console.error('Error reading articles directory:', e);
  }
  
  // Now process each article
  articles.forEach((article: Article) => {
    // Check if currently downloading from queue
    if (currentlyDownloading.has(article.savedId)) {
      articleStatus[article.savedId] = 'downloading';
      downloading++;
    } else if (completedArticles.has(article.savedId)) {
      articleStatus[article.savedId] = 'completed';
      completed++;
    } else {
      articleStatus[article.savedId] = 'pending';
    }
  });

  return {
    total: Object.keys(articleStatus).length,
    completed,
    downloading,
    errors,
    articleStatus
  };
}