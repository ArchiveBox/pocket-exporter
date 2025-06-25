import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { withTiming } from '@/lib/with-timing';

export const GET = withTiming(async (request: NextRequest) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');
    const savedId = searchParams.get('savedId');

    if (!sessionId || !savedId) {
      return NextResponse.json(
        { error: 'Session ID and savedId are required' },
        { status: 400 }
      );
    }

    const articleHtmlPath = path.join(
      process.cwd(), 
      'sessions', 
      sessionId, 
      'articles', 
      savedId, 
      'article.html'
    );

    let htmlContent: string;
    try {
      htmlContent = await fs.promises.readFile(articleHtmlPath, 'utf8');
    } catch (e) {
      return NextResponse.json(
        { error: 'Article HTML not found' },
        { status: 404 }
      );
    }

    // Check if HTML is empty or too short (< 256 chars)
    if (!htmlContent || htmlContent.trim().length < 256) {
      // Try to load index.json for fallback rendering
      const indexJsonPath = path.join(
        process.cwd(),
        'sessions',
        sessionId,
        'articles',
        savedId,
        'index.json'
      );

      try {
        const indexContent = await fs.promises.readFile(indexJsonPath, 'utf8');
        const indexData = JSON.parse(indexContent);
        
        // Check if it's a video
        if (indexData.item?.hasVideo === 'IS_VIDEO' || indexData.item?.hasVideo === 'HAS_VIDEOS') {
          // Extract video URL and create iframe
          let videoUrl = indexData.url || indexData.item?.givenUrl || '';
          const originalUrl = videoUrl;
          const title = indexData.title || 'Video';
          
          // Convert video URLs to embeddable format
          
          // YouTube
          const youtubeMatch = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/v\/|youtube\.com\/embed\/)([^&\n?#]+)/);
          if (youtubeMatch) {
            videoUrl = `https://www.youtube.com/embed/${youtubeMatch[1]}`;
          } else if (videoUrl.includes('youtube.com') && videoUrl.includes('/shorts/')) {
            // Handle YouTube Shorts
            const shortsMatch = videoUrl.match(/youtube\.com\/shorts\/([^&\n?#]+)/);
            if (shortsMatch) {
              videoUrl = `https://www.youtube.com/embed/${shortsMatch[1]}`;
            }
          }
          
          // Vimeo
          const vimeoMatch = videoUrl.match(/(?:vimeo\.com\/)(\d+)/);
          if (vimeoMatch) {
            videoUrl = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
          }
          
          // Dailymotion
          const dailymotionMatch = videoUrl.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([^_\s]+)/);
          if (dailymotionMatch) {
            videoUrl = `https://www.dailymotion.com/embed/video/${dailymotionMatch[1]}`;
          }
          
          // Twitch clips
          const twitchClipMatch = videoUrl.match(/clips\.twitch\.tv\/([^\s?]+)/);
          if (twitchClipMatch) {
            videoUrl = `https://clips.twitch.tv/embed?clip=${twitchClipMatch[1]}&parent=${request.headers.get('host') || 'localhost'}`;
          }
          
          // Twitch videos
          const twitchVideoMatch = videoUrl.match(/twitch\.tv\/videos\/(\d+)/);
          if (twitchVideoMatch) {
            videoUrl = `https://player.twitch.tv/?video=${twitchVideoMatch[1]}&parent=${request.headers.get('host') || 'localhost'}`;
          }
          
          // TikTok
          const tiktokMatch = videoUrl.match(/tiktok\.com\/@[\w.-]+\/video\/(\d+)/);
          if (tiktokMatch) {
            videoUrl = `https://www.tiktok.com/embed/${tiktokMatch[1]}`;
          }
          
          // Twitter/X videos
          const twitterMatch = videoUrl.match(/(?:twitter|x)\.com\/[\w]+\/status\/(\d+)/);
          if (twitterMatch) {
            videoUrl = `https://platform.twitter.com/embed/Tweet.html?id=${twitterMatch[1]}`;
          }
          
          // Facebook videos
          const facebookMatch = videoUrl.match(/facebook\.com\/.*\/videos\/(\d+)/);
          if (facebookMatch) {
            videoUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(originalUrl)}`;
          }
          
          // Instagram posts/reels
          const instagramMatch = videoUrl.match(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
          if (instagramMatch) {
            videoUrl = `https://www.instagram.com/p/${instagramMatch[1]}/embed/`;
          }
          
          const fallbackHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { margin-bottom: 20px; }
    .video-container { position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; }
    .video-container iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
    .link { margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <div class="video-container">
      <iframe src="${videoUrl}" frameborder="0" allowfullscreen></iframe>
    </div>
    <div class="link">
      <a href="${originalUrl}" target="_blank">Open original video</a>
    </div>
  </div>
</body>
</html>`;
          
          return new NextResponse(fallbackHtml, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8'
            }
          });
        } else {
          // Non-video content - show link to original
          const url = indexData.url || indexData.item?.givenUrl || '';
          const title = indexData.title || url;
          const excerpt = indexData.item?.preview?.excerpt || '';
          
          const fallbackHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 20px; }
    .container { max-width: 1600px; margin: 0 auto; }
    h1 { margin-bottom: 10px; }
    .excerpt { color: #666; margin: 20px 0; }
    .link { margin-top: 20px; font-size: 18px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <br/>
    <p class="excerpt">${excerpt}</p>
    <br>
    <hr/>
    <br/>
    <div class="link">
      <a href="${url}" target="_blank">Open Original URL 🔗:</a> <code>${url}</code>
    </div>
    <pre>${JSON.stringify(indexData, null, 4)}</pre>
  </div>
</body>
</html>`;
          
          return new NextResponse(fallbackHtml, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8'
            }
          });
        }
      } catch (e) {
        // index.json doesn't exist, continue with empty/short HTML
      }
    }

    // Return as viewable HTML (not forced download)
    return new NextResponse(htmlContent, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8'
      }
    });

  } catch (error) {
    console.error('Get article HTML error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});
