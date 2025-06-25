import Stripe from 'stripe';

let stripeInstance: Stripe | null = null;

export const getStripe = () => {
  if (!stripeInstance) {
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
      apiVersion: '2024-12-18.acacia',
    });
  }
  return stripeInstance;
};

export const stripe = new Proxy({} as Stripe, {
  get(target, prop, receiver) {
    const instance = getStripe();
    return Reflect.get(instance, prop, instance);
  }
});