import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
import { withTiming } from '@/lib/with-timing';

export const GET = withTiming(async (request: NextRequest) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    const session = await exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Get all articles for the session
    const articles = await exportStore.getSessionArticles(sessionId);
    
    // Create session data with articles merged in
    const sessionData = {
      ...session,
      articles
    };
    
    return new NextResponse(JSON.stringify(sessionData, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="session-${sessionId}.json"`,
      },
    });
    
  } catch (error) {
    console.error('Download session JSON error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});