#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { handleRateLimit, respectRateLimit, getCurrentBackoff, increaseBackoff, resetBackoff } = require('./helpers');

const ARTICLES_DIR = path.join(__dirname, 'articles');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    resumeFrom: null
  };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' && i + 1 < args.length) {
      options.resumeFrom = args[i + 1];
      i++; // Skip the next argument since we consumed it
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node download_article_images.js [options]');
      console.log('\nOptions:');
      console.log('  --resume <articleId>  Resume downloading from the specified article ID (readerSlug)');
      console.log('  --help, -h           Show this help message');
      console.log('\nExample:');
      console.log('  node download_article_images.js --resume 4083916229');
      process.exit(0);
    }
  }
  
  return options;
}

function getProtocol(url) {
  return url.startsWith('https://') ? https : http;
}

function downloadFile(url, destPath, timeoutMs = 20000) {
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
    let downloadTimeout;
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
    const cleanupAndReject = (error) => {
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
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
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
            } catch (err) {
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

function getImageFilename(url, index) {
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

// Queue-based download manager with separate active/pending limits
class DownloadManager {
  constructor(maxActive = 20, maxPending = 100) {
    this.maxActive = maxActive;
    this.maxPending = maxPending;
    this.activeDownloads = 0;
    this.pendingQueue = [];
    this.results = { downloaded: 0, skipped: 0, errors: 0 };
    this.pocketErrors = 0;
  }

  async addDownload(task) {
    if (this.pendingQueue.length >= this.maxPending) {
      // Wait for some downloads to complete
      await new Promise(resolve => {
        const checkQueue = setInterval(() => {
          if (this.pendingQueue.length < this.maxPending) {
            clearInterval(checkQueue);
            resolve();
          }
        }, 100);
      });
    }

    return new Promise((resolve) => {
      this.pendingQueue.push({ task, resolve });
      this.processQueue();
    });
  }

  async processQueue() {
    while (this.pendingQueue.length > 0 && this.activeDownloads < this.maxActive) {
      const { task, resolve } = this.pendingQueue.shift();
      this.activeDownloads++;
      
      task()
        .then(result => {
          this.activeDownloads--;
          this.results[result.status]++;
          if (result.status === 'error' && result.url && 
              (result.url.includes('getpocket.com') || result.url.includes('pocket-image-cache.com'))) {
            this.pocketErrors++;
          }
          resolve(result);
          this.processQueue();
        })
        .catch(error => {
          this.activeDownloads--;
          this.results.errors++;
          resolve({ status: 'error', error });
          this.processQueue();
        });
    }
  }

  getResults() {
    return this.results;
  }
}

async function downloadWithTimeout(url, destPath, timeout = 20000, fallbackUrls = []) {
  // Try primary URL first
  try {
    // Add rate limiting for getpocket.com URLs
    if (url.includes('getpocket.com') || url.includes('pocket-image-cache.com')) {
      await respectRateLimit();
    }
    
    await downloadFile(url, destPath, timeout);
    resetBackoff(); // Reset on successful download
    return { status: 'downloaded', url };
  } catch (error) {
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
        } catch (fallbackError) {
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
    return { status: 'error', error: error.message, url, fallbacksAttempted: fallbackUrls?.length || 0 };
  }
}

async function processArticleImages(folder, downloadManager) {
  const articleDir = path.join(ARTICLES_DIR, folder);
  const indexPath = path.join(articleDir, 'index.json');

  if (!fs.existsSync(indexPath)) {
    return { folder, processed: false };
  }

  try {
    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const imageUrls = [];
    
    // First, build a map of all cached URLs for any given primary URL
    const cachedUrlMap = new Map(); // Maps primary URL -> array of cached URLs
    
    // Collect cached URLs from preview
    if (indexData.item?.preview?.image?.url && indexData.item?.preview?.image?.cachedImages) {
      const primaryUrl = indexData.item.preview.image.url;
      const cachedUrls = indexData.item.preview.image.cachedImages.map(img => img.url).filter(Boolean);
      if (cachedUrls.length > 0) {
        cachedUrlMap.set(primaryUrl, cachedUrls);
      }
    }
    
    // Prepare image data with fallbacks
    const imageMap = new Map(); // Key: unique identifier, Value: { primary, fallbacks, type, index }
    
    // Process top image
    if (indexData.item?.topImageUrl) {
      const fallbacks = cachedUrlMap.get(indexData.item.topImageUrl) || [];
      imageMap.set('top', { 
        primary: indexData.item.topImageUrl, 
        fallbacks, 
        type: 'top' 
      });
    }
    
    // Process content images
    if (indexData.item?.images && Array.isArray(indexData.item.images)) {
      indexData.item.images.forEach((img, idx) => {
        if (img.src) {
          // Use cached versions if this URL matches any cached URL we found
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
    
    // Process preview image (always add it, even if URL is duplicate)
    if (indexData.item?.preview?.image?.url) {
      const previewUrl = indexData.item.preview.image.url;
      const cachedUrls = cachedUrlMap.get(previewUrl) || [];
      
      imageMap.set('preview', {
        primary: previewUrl,
        fallbacks: cachedUrls,
        type: 'preview'
      });
    }

    if (imageMap.size === 0) {
      return { folder, processed: true, imageCount: 0 };
    }

    let queuedCount = 0;
    let skippedCount = 0;

    // Queue all images for download with fallbacks
    const downloadPromises = Array.from(imageMap.entries()).map(([key, imgData]) => {
      const { primary, fallbacks, type, index = 0 } = imgData;
      
      // Generate filename based on type and index
      let filename;
      if (type === 'top') {
        filename = 'top_image' + path.extname(getImageFilename(primary, 0));
      } else if (type === 'preview') {
        filename = 'preview_image' + path.extname(getImageFilename(primary, 0));
      } else {
        filename = getImageFilename(primary, index);
      }
      
      const destPath = path.join(articleDir, filename);

      // Skip if already exists with non-zero size
      if (fs.existsSync(destPath)) {
        const stats = fs.statSync(destPath);
        if (stats.size > 0) {
          skippedCount++;
          return Promise.resolve({ status: 'skipped' });
        }
        // Remove empty files and re-download
        fs.unlinkSync(destPath);
      }

      // Add to download queue with fallbacks
      queuedCount++;
      return downloadManager.addDownload(() => downloadWithTimeout(primary, destPath, 20000, fallbacks));
    });

    // Wait for all downloads to be queued (not necessarily completed)
    await Promise.all(downloadPromises);
    
    if (queuedCount > 0) {
      console.log(`Queued ./articles/${folder}: ${queuedCount} new, ${skippedCount} skipped`);
    }

    return { folder, processed: true, imageCount: imageMap.size, queued: queuedCount, skipped: skippedCount };

  } catch (error) {
    console.error(`Error processing ./articles/${folder}:`, error.message);
    return { folder, processed: false, error: error.message };
  }
}

async function downloadArticleImages() {
  const options = parseArgs();
  
  console.log('Starting to download article images...');
  console.log('Configuration: Max 20 active downloads, up to 100 pending in queue');
  
  if (options.resumeFrom) {
    console.log(`\n📍 Resuming from article ID: ${options.resumeFrom}`);
  }
  
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.error('Articles directory not found. Run get_all_articles.js first.');
    return;
  }

  let folders = fs.readdirSync(ARTICLES_DIR).filter(f => {
    return fs.statSync(path.join(ARTICLES_DIR, f)).isDirectory();
  });

  // Sort folders to ensure consistent ordering
  folders.sort();
  
  let skippedForResume = 0;
  if (options.resumeFrom) {
    // Find the index of the resume folder
    const resumeIndex = folders.indexOf(options.resumeFrom);
    if (resumeIndex === -1) {
      console.error(`\n❌ Error: Article ID '${options.resumeFrom}' not found in articles directory.`);
      console.log('Available article IDs:', folders.slice(0, 5).join(', '), '...');
      return;
    }
    
    // Skip all folders before the resume point
    skippedForResume = resumeIndex;
    folders = folders.slice(resumeIndex);
    console.log(`Skipping ${skippedForResume} articles before resume point\n`);
  }

  console.log(`Processing ${folders.length} article folders`);

  const downloadManager = new DownloadManager(20, 100);
  let processedFolders = 0;
  let totalImages = 0;
  const totalSkippedForResume = skippedForResume; // Store for final stats

  // Process all folders and queue their images
  for (const folder of folders) {
    const result = await processArticleImages(folder, downloadManager);
    if (result.processed) {
      processedFolders++;
      totalImages += result.imageCount || 0;
    }
    
    // Show progress every 50 folders
    if (processedFolders % 50 === 0) {
      const stats = downloadManager.getResults();
      console.log(`Progress: ${processedFolders}/${folders.length} folders queued | ` +
                  `Downloaded: ${stats.downloaded} | Skipped: ${stats.skipped} | Errors: ${stats.errors}`);
    }
  }

  console.log(`\nAll folders processed. Waiting for remaining downloads to complete...`);
  
  // Wait for all downloads to complete
  await new Promise(resolve => {
    const checkComplete = setInterval(() => {
      if (downloadManager.activeDownloads === 0 && downloadManager.pendingQueue.length === 0) {
        clearInterval(checkComplete);
        resolve();
      } else {
        const stats = downloadManager.getResults();
        console.log(`Active: ${downloadManager.activeDownloads} | Pending: ${downloadManager.pendingQueue.length} | ` +
                    `Downloaded: ${stats.downloaded} | Errors: ${stats.errors}`);
      }
    }, 2000);
  });

  const finalStats = downloadManager.getResults();
  console.log(`\nCompleted!`);
  if (totalSkippedForResume > 0) {
    console.log(`Articles skipped (before resume point): ${totalSkippedForResume}`);
  }
  console.log(`Folders processed: ${processedFolders}`);
  console.log(`Total images queued: ${totalImages}`);
  console.log(`Images downloaded: ${finalStats.downloaded}`);
  console.log(`Images skipped (already exist): ${finalStats.skipped}`);
  console.log(`Errors: ${finalStats.errors}`);
  
  if (downloadManager.pocketErrors > 0) {
    console.log(`\n⚠️  ${downloadManager.pocketErrors} Pocket image URLs failed (may be rate limited)`);
    console.log(`Current backoff: ${getCurrentBackoff()/1000}s (${Math.round(getCurrentBackoff()/60000)} minutes)`);
    console.log(`These will be automatically retried on the next run.`);
  }
}

// Run the script
downloadArticleImages().catch(console.error);
