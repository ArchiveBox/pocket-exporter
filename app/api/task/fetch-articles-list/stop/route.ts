import { NextRequest, NextResponse } from 'next/server';
import { exportStore } from '@/lib/export-store';
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

    const session = await exportStore.getSession(sessionId);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Session not found' },
        { status: 404 }
      );
    }

    // Update fetch task status to stopped
    await exportStore.updateFetchTask(sessionId, {
      status: 'stopped',
      endedAt: new Date()
    });

    console.log(`Stopped fetch task for session ${sessionId}`);

    return NextResponse.json({ 
      success: true 
    });

  } catch (error) {
    console.error('Stop fetch task error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
});