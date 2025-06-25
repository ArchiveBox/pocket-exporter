import { NextRequest, NextResponse } from 'next/server';
import { startArticleDownloads } from '@/lib/article-downloader';
import { exportStore } from '@/lib/export-store';

export async function POST(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('sessionId');

    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: 'Session ID is required' },
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

    // Check if a download task is already running
    if (session.currentDownloadTask?.status === 'running') {
      return NextResponse.json(
        { success: false, error: 'Download task is already running' },
        { status: 409 }
      );
    }

    // Get all articles for the session
    const articles = exportStore.getSessionArticles(sessionId);
    
    if (articles.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No articles found to download' },
        { status: 400 }
      );
    }

    // Start downloading articles - this updates the session automatically
    startArticleDownloads(sessionId, articles, session.auth);

    return NextResponse.json({ 
      success: true,
      articlesToDownload: articles.length
    });

  } catch (error) {
    console.error('Start download task error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}