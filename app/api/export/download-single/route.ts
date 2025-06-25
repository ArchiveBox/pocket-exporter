import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import { startArticleDownloads } from '@/lib/article-downloader';

export async function POST(request: NextRequest) {
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

    const session = exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Get the specific article
    const articles = exportStore.getSessionArticles(sessionId);
    const article = articles.find(a => a.savedId === articleId);
    
    if (!article) {
      return NextResponse.json(
        { error: 'Article not found' },
        { status: 404 }
      );
    }

    // Start downloading content for just this article
    startArticleDownloads(sessionId, [article], session.auth);

    return NextResponse.json({
      success: true,
      message: `Started downloading content for article ${articleId}`
    });

  } catch (error) {
    console.error('Download single article error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}