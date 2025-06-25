#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ARTICLES_DIR = path.join(__dirname, 'articles');

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, stdio: 'inherit' });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function checkYtDlp() {
  try {
    await runCommand('yt-dlp', ['--version'], process.cwd());
    return true;
  } catch (e) {
    console.error('yt-dlp is not installed. Please install it first:');
    console.error('  brew install yt-dlp  (on macOS)');
    console.error('  pip install yt-dlp   (with Python)');
    return false;
  }
}

function extractVideoId(video) {
  // For YouTube videos, extract the video ID
  if (video.type === 'YOUTUBE' && video.vid) {
    return video.vid;
  }
  
  // Try to extract from src URL
  if (video.src) {
    const match = video.src.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
    if (match) return match[1];
  }
  
  return null;
}

async function downloadArticleVideos() {
  console.log('Checking for yt-dlp...');
  if (!await checkYtDlp()) {
    return;
  }

  console.log('Starting to download article videos...');
  
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.error('Articles directory not found. Run get_all_articles.js first.');
    return;
  }

  const folders = fs.readdirSync(ARTICLES_DIR).filter(f => {
    return fs.statSync(path.join(ARTICLES_DIR, f)).isDirectory();
  });

  console.log(`Found ${folders.length} article folders`);

  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const folder of folders) {
    const articleDir = path.join(ARTICLES_DIR, folder);
    const indexPath = path.join(articleDir, 'index.json');

    if (!fs.existsSync(indexPath)) {
      console.warn(`No index.json found in ${folder}`);
      continue;
    }

    try {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      
      // Check for videos array
      if (!indexData.item?.videos || !Array.isArray(indexData.item.videos) || indexData.item.videos.length === 0) {
        continue;
      }

      console.log(`\nProcessing ${folder} (${indexData.item.videos.length} videos)...`);

      for (let i = 0; i < indexData.item.videos.length; i++) {
        const video = indexData.item.videos[i];
        const videoId = extractVideoId(video);
        
        if (!videoId && !video.src) {
          console.warn(`  No valid video URL found for video ${i}`);
          totalErrors++;
          continue;
        }

        // Check if video already exists (common video formats)
        const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov'];
        const existingVideo = videoExtensions.some(ext => {
          return fs.existsSync(path.join(articleDir, `video_${i}${ext}`)) ||
                 (videoId && fs.existsSync(path.join(articleDir, `${videoId}${ext}`)));
        });

        if (existingVideo) {
          console.log(`  Video ${i} already downloaded, skipping...`);
          totalSkipped++;
          continue;
        }

        // Construct video URL
        let videoUrl;
        if (video.type === 'YOUTUBE' && videoId) {
          videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        } else if (video.src) {
          videoUrl = video.src;
        } else {
          console.warn(`  Cannot construct valid URL for video ${i}`);
          totalErrors++;
          continue;
        }

        try {
          console.log(`  Downloading video ${i} from ${videoUrl}...`);
          
          // yt-dlp arguments
          const args = [
            '--add-metadata',
            '--continue',
            '--no-playlist',
            '--output', path.join(articleDir, `video_${i}.%(ext)s`),
            videoUrl
          ];

          await runCommand('yt-dlp', args, process.cwd());
          totalDownloaded++;
          console.log(`  ✓ Downloaded video ${i}`);
          
        } catch (error) {
          console.error(`  Failed to download video ${i}:`, error.message);
          totalErrors++;
        }

        // Rate limiting between videos
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

    } catch (error) {
      console.error(`Error processing ${folder}:`, error.message);
      totalErrors++;
    }
  }

  console.log(`\nCompleted!`);
  console.log(`Videos downloaded: ${totalDownloaded}`);
  console.log(`Videos skipped (already exist): ${totalSkipped}`);
  console.log(`Errors: ${totalErrors}`);
}

// Run the script
downloadArticleVideos().catch(console.error);