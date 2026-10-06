'use strict';

// Top-ups through Stripe Checkout (hosted version only).
//   STRIPE_SECRET_KEY      sk_live_… or sk_test_…
//   STRIPE_WEBHOOK_SECRET  whsec_… from the webhook endpoint in the Stripe dashboard
//   PUBLIC_URL             e.g. https://rezepte.example.ch (where Stripe sends people back)
//
// The payment methods shown (cards, Apple Pay, Google Pay, TWINT for CHF,
// SEPA for EUR, …) are the ones switched on in the Stripe dashboard.

let Stripe = null;
try {
  const mod = require('stripe');
  Stripe = mod.default || mod;
} catch {
  Stripe = null; // not installed or Node too old (needs 20+)
}

const deps = { stripe: null }; // replaced in tests

function isEnabled() {
  return Boolean(deps.stripe || (Stripe && process.env.STRIPE_SECRET_KEY));
}

function client() {
  if (!deps.stripe) deps.stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return deps.stripe;
}

class BillingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function createCheckout({ user, amountMinor, currency, baseUrl, lang = 'auto' }) {
  if (!isEnabled()) throw new BillingError(503, 'Payments are not set up on this server yet.');
  const value = (amountMinor / 100).toFixed(2);
  const session = await client().checkout.sessions.create({
    mode: 'payment',
    client_reference_id: user.id,
    customer_email: user.email,
    locale: ['de', 'en', 'fr', 'it', 'es', 'nl'].includes(lang) ? lang : 'auto',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: amountMinor,
        product_data: { name: `Recipe Box credit ${currency} ${value}` },
      },
    }],
    metadata: { userId: user.id, amountMinor: String(amountMinor), currency },
    success_url: `${baseUrl}/account?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/account?cancelled=1`,
  });
  return { id: session.id, url: session.url };
}

// A paid Checkout session -> what to credit, or null if it isn't paid.
function creditFromSession(session) {
  if (!session || session.payment_status !== 'paid') return null;
  const userId = session.metadata?.userId || session.client_reference_id;
  const amountMinor = Number(session.metadata?.amountMinor ?? session.amount_total);
  const currency = String(session.metadata?.currency || session.currency || '').toUpperCase();
  if (!userId || !Number.isInteger(amountMinor) || amountMinor <= 0) return null;
  return { userId, amountMinor, currency, ref: session.id };
}

async function retrieveSession(id) {
  if (!isEnabled()) throw new BillingError(503, 'Payments are not set up on this server yet.');
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(id || ''))) throw new BillingError(400, 'Invalid payment reference.');
  return client().checkout.sessions.retrieve(id);
}

// Check the Stripe-Signature header and return the event.
function verifyWebhook(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!isEnabled() || !secret) throw new BillingError(503, 'Webhooks are not set up on this server.');
  try {
    return client().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new BillingError(400, 'Invalid webhook signature.');
  }
}

module.exports = { isEnabled, createCheckout, creditFromSession, retrieveSession, verifyWebhook, BillingError, deps };
