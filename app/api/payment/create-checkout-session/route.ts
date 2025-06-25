import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { updatePaymentData, readPaymentData } from '@/lib/session-utils';
import { withTiming } from '@/lib/with-timing';

// Price configuration
const PRICE_AMOUNT = 800; // $8.00 in cents
const PRICE_CURRENCY = 'usd';

export const POST = withTiming(async (request: NextRequest) => {
  try {
    const { sessionId } = await request.json();
    
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    // Check if there's already a payment session
    const existingPaymentData = await readPaymentData(sessionId);
    
    // If there's a pending or completed payment, verify its status with Stripe
    if (existingPaymentData?.payment?.stripeSessionId) {
      try {
        const stripeSession = await stripe.checkout.sessions.retrieve(
          existingPaymentData.payment.stripeSessionId
        );
        
        // If payment is complete, update local data and prevent new session
        if (stripeSession.status === 'complete') {
          await updatePaymentData(sessionId, {
            hasUnlimitedAccess: true,
            payment: {
              ...existingPaymentData.payment,
              status: 'completed',
              completedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          });
          
          return NextResponse.json({ 
            error: 'Payment already completed',
            alreadyPaid: true 
          }, { status: 400 });
        }
        
        // If session is still open/active, return it instead of creating a new one
        if (stripeSession.status === 'open' && stripeSession.expires_at > Date.now() / 1000) {
          return NextResponse.json({ 
            clientSecret: stripeSession.client_secret,
            existingSession: true
          });
        }
      } catch (error) {
        // If session retrieval fails, continue to create a new one
        console.log('Could not retrieve existing session, creating new one');
      }
    }

    // Create initial payment record
    updatePaymentData(sessionId, {
      payment: {
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    // First, create or retrieve the price for the product
    let priceId: string;
    try {
      // List existing prices for the product
      const prices = await stripe.prices.list({
        // product: 'prod_SYxIQkjLRLagZc',  // testing
        product: 'prod_SZ0ArYlasOFd3v',
        active: true,
        limit: 100  // Get all prices to find the right one
      });
      
      // Find the price that matches our desired amount
      const matchingPrice = prices.data.find(price => 
        price.unit_amount === PRICE_AMOUNT && 
        price.currency === PRICE_CURRENCY &&
        price.type === 'one_time'
      );
      
      if (matchingPrice) {
        priceId = matchingPrice.id;
      } else {
        // Create a price if none exists with the correct amount
        const price = await stripe.prices.create({
          // product: 'prod_SYxIQkjLRLagZc',  // testing
          product: 'prod_SZ0ArYlasOFd3v',
          unit_amount: PRICE_AMOUNT,
          currency: PRICE_CURRENCY,
        });
        priceId = price.id;
      }
    } catch (error) {
      console.error('Error with price:', error);
      // Fallback to creating price inline
      priceId = '';
    }

    // Create Stripe checkout session with embedded UI mode
    const lineItems = priceId ? [{
      price: priceId,
      quantity: 1,
    }] : [{
      price_data: {
        currency: PRICE_CURRENCY,
        product_data: {
          name: 'Pocket Exporter Unlimited Access',
          description: 'Export unlimited articles from your Pocket account'
        },
        unit_amount: PRICE_AMOUNT,
      },
      quantity: 1,
    }];

    const checkoutSession = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      line_items: lineItems,
      mode: 'payment',
      return_url: `${request.headers.get('origin')}/?session=${sessionId}`,
      metadata: {
        appSessionId: sessionId, // Store our session ID in Stripe metadata
      },
      payment_intent_data: {
        metadata: {
          appSessionId: sessionId
        }
      }
    });

    // Update payment record with Stripe session ID and payment intent if available
    await updatePaymentData(sessionId, {
      payment: {
        status: 'pending',
        stripeSessionId: checkoutSession.id,
        stripePaymentIntentId: checkoutSession.payment_intent as string || undefined,
        amount: checkoutSession.amount_total || PRICE_AMOUNT,
        currency: checkoutSession.currency || PRICE_CURRENCY,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });
    
    console.log(`Created checkout session ${checkoutSession.id} with payment intent: ${checkoutSession.payment_intent}`);

    return NextResponse.json({ 
      clientSecret: checkoutSession.client_secret 
    });
  } catch (err: any) {
    console.error('Error creating checkout session:', err);
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
});
