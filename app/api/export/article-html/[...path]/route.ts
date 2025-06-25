import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.tiff': 'image/tiff',
  '.html': 'text/html',
};

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    const pathSegments = params.path;
    
    if (pathSegments.length < 3) {
      return NextResponse.json(
        { error: 'Invalid path' },
        { status: 400 }
      );
    }
    
    const [sessionId, articleId, ...filePathParts] = pathSegments;
    const fileName = filePathParts.join('/');
    
    // Construct the full file path
    const filePath = path.join(
      process.cwd(),
      'sessions',
      sessionId,
      'articles',
      articleId,
      fileName
    );
    
    // Security check - ensure the resolved path is within the article directory
    const articleDir = path.join(process.cwd(), 'sessions', sessionId, 'articles', articleId);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(articleDir))) {
      return NextResponse.json(
        { error: 'Invalid path' },
        { status: 403 }
      );
    }
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 }
      );
    }
    
    // Get file stats
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return NextResponse.json(
        { error: 'Not a file' },
        { status: 400 }
      );
    }
    
    // Read the file
    const fileBuffer = fs.readFileSync(filePath);
    
    // Determine content type
    const ext = path.extname(fileName).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    // Create response with proper headers
    const response = new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': stats.size.toString(),
        // Cache forever since images are immutable
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': `"${stats.mtime.getTime()}-${stats.size}"`,
        'Last-Modified': stats.mtime.toUTCString(),
      },
    });
    
    return response;
    
  } catch (error) {
    console.error('Error serving static file:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}