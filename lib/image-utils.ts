import fs from 'fs';
import path from 'path';

interface ImageInfo {
  path: string;
  size: number;
  extension: string;
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.tiff', '.gif'];
const MIN_SIZE = 16 * 1024; // 16KB
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export function findFallbackImages(articleDir: string): string[] {
  const fallbackUrls: string[] = [];
  
  if (!fs.existsSync(articleDir)) {
    return fallbackUrls;
  }

  try {
    const images: ImageInfo[] = [];
    
    // Recursively find all image files
    function scanDirectory(dir: string) {
      const files = fs.readdirSync(dir);
      
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
          scanDirectory(filePath);
        } else {
          const ext = path.extname(file).toLowerCase();
          if (IMAGE_EXTENSIONS.includes(ext) && stat.size > MIN_SIZE && stat.size < MAX_SIZE) {
            images.push({
              path: filePath,
              size: stat.size,
              extension: ext
            });
          }
        }
      }
    }
    
    scanDirectory(articleDir);
    
    // Sort by size (largest first)
    images.sort((a, b) => b.size - a.size);
    
    // Convert to relative URLs for serving
    for (const image of images) {
      // Extract the relative path from the article directory
      const relativePath = path.relative(articleDir, image.path);
      fallbackUrls.push(relativePath);
    }
    
  } catch (error) {
    console.error(`Error scanning article directory ${articleDir}:`, error);
  }
  
  return fallbackUrls;
}

export function enrichArticleWithFallbackImages(article: any, sessionId: string): any {
  const articleDir = path.join(process.cwd(), 'sessions', sessionId, 'articles', article.savedId);
  const fallbackImages = findFallbackImages(articleDir);
  
  return {
    ...article,
    fallbackImageUrls: fallbackImages.map(img => 
      `/api/export/article-html/${sessionId}/${article.savedId}/${img}`
    )
  };
}