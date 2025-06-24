import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('sessionId');
    const lastFetchedCount = searchParams.get('lastFetchedCount');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    const session = exportStore.getSession(sessionId);

    if (!session) {
      console.error('Session not found:', sessionId);
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Calculate which articles are new since last fetch
    const lastCount = lastFetchedCount ? parseInt(lastFetchedCount) : 0;
    const newArticles = session.articles.slice(lastCount);

    return NextResponse.json({
      sessionId: session.id,
      status: session.status,
      progress: session.progress,
      totalCount: session.totalCount,
      fetchedCount: session.fetchedCount,
      newArticles,
      error: session.error,
      rateLimitedAt: session.rateLimitedAt,
      rateLimitRetryAfter: session.rateLimitRetryAfter,
      startedAt: session.startedAt,
      completedAt: session.completedAt
    });

  } catch (error) {
    console.error('Get status error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}