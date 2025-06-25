import Stripe from 'stripe';

const getStripe = () => {
  return new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2024-12-18.acacia',
  });
};

// Lazy initialization to avoid build-time errors
let stripeInstance: Stripe | null = null;

export const stripe = new Proxy({} as Stripe, {
  get(target, prop) {
    if (!stripeInstance) {
      stripeInstance = getStripe();
    }
    return Reflect.get(stripeInstance, prop, stripeInstance);
  },
  has(target, prop) {
    if (!stripeInstance) {
      stripeInstance = getStripe();
    }
    return Reflect.has(stripeInstance, prop);
  },
  set(target, prop, value) {
    if (!stripeInstance) {
      stripeInstance = getStripe();
    }
    return Reflect.set(stripeInstance, prop, value, stripeInstance);
  }
});