import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const articleId = searchParams.get('articleId');

    if (!sessionId || !articleId) {
      return NextResponse.json(
        { error: 'Session ID and Article ID are required' },
        { status: 400 }
      );
    }

    const articleHtmlPath = path.join(
      process.cwd(), 
      'sessions', 
      sessionId, 
      'articles', 
      articleId, 
      'article.html'
    );

    if (!fs.existsSync(articleHtmlPath)) {
      return NextResponse.json(
        { error: 'Article HTML not found' },
        { status: 404 }
      );
    }

    const htmlContent = fs.readFileSync(articleHtmlPath, 'utf8');

    // Return as downloadable HTML file
    return new NextResponse(htmlContent, {
      headers: {
        'Content-Type': 'text/html',
        'Content-Disposition': `attachment; filename="${articleId}.html"`
      }
    });

  } catch (error) {
    console.error('Get article HTML error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}