import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import { downloadSingleArticle } from '@/lib/article-downloader';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('session');
    const articleId = searchParams.get('articleId');

    if (!sessionId || !articleId) {
      return NextResponse.json(
        { success: false, error: 'Session ID and Article ID are required' },
        { status: 400 }
      );
    }

    const session = exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Session not found' },
        { status: 404 }
      );
    }

    if (!session.auth) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Get the specific article
    const articles = await exportStore.getSessionArticlesAsync(sessionId);
    const article = articles.find(a => a.savedId === articleId);
    
    if (!article) {
      return NextResponse.json(
        { success: false, error: 'Article not found' },
        { status: 404 }
      );
    }

    // Download content for just this article without updating session task
    const result = await downloadSingleArticle(sessionId, article, session.auth);

    if (result.success) {
      return NextResponse.json({
        success: true,
        alreadyDownloaded: result.alreadyDownloaded || false
      });
    } else {
      return NextResponse.json(
        { success: false, error: result.error || 'Failed to download article' },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error('Download single article error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}