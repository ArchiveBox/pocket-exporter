import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { withTiming } from '@/lib/with-timing';

export const GET = withTiming(async (request: NextRequest) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('session_id');
    
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    return NextResponse.json({
      status: session.status,
      customer_email: session.customer_details?.email || null
    });
  } catch (err: any) {
    console.error('Error retrieving session status:', err);
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
});