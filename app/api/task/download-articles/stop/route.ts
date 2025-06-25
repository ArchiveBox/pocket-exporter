import { NextRequest, NextResponse } from 'next/server';
import { stopDownloads } from '@/lib/article-downloader';
import { withTiming } from '@/lib/with-timing';

export const POST = withTiming(async (request: NextRequest) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session');

    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: 'Session ID is required' },
        { status: 400 }
      );
    }

    // Stop downloads - this updates the session automatically
    stopDownloads(sessionId);

    console.log(`Stopped download task for session ${sessionId}`);

    return NextResponse.json({ 
      success: true 
    });

  } catch (error) {
    console.error('Stop download task error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
});