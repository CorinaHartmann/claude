'use strict';

// Prepaid credit for the hosted version. Users top up (Stripe) and each Claude
// action is charged at its measured cost times PRICE_MARKUP, in the user's
// currency. Amounts are kept in minor units (cents / Rappen).
//
//   PRICE_MARKUP   what users pay relative to the Claude cost   (default 3)
//   USD_TO_EUR     exchange rate used for EUR prices            (default 0.86)
//   USD_TO_CHF     exchange rate used for CHF prices            (default 0.80)
//   START_CREDIT   credit for new accounts, in cents/Rappen     (default 0)

const fsp = require('fs').promises;
const path = require('path');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);

function config() {
  return {
    markup: num(process.env.PRICE_MARKUP, 3),
    fx: { EUR: num(process.env.USD_TO_EUR, 0.86), CHF: num(process.env.USD_TO_CHF, 0.8) },
    startCredit: Math.max(0, Math.round(num(process.env.START_CREDIT, 0))),
  };
}

// Typical Claude cost of each action in US dollars, used to show a price before
// the action runs and to check that the balance covers it. The real charge is
// always the measured cost.
const TYPICAL_USD = { 'read-text': 0.03, 'read-photo': 0.06, translate: 0.03, 'compare-prices': 0.4 };
const PACKS = [500, 1000, 2000]; // top-up amounts in cents/Rappen

// What the user pays for a Claude cost, in minor units of their currency (at least 1).
function priceMinor(usd, currency) {
  const { markup, fx } = config();
  return Math.max(1, Math.ceil(usd * markup * (fx[currency] || 1) * 100));
}

function priceList(currency) {
  return Object.fromEntries(Object.entries(TYPICAL_USD).map(([action, usd]) => [action, priceMinor(usd, currency)]));
}

class CreditError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

class Credits {
  constructor(dir, currency) {
    this.path = path.join(dir, 'credits.json');
    this.currency = currency;
    this.balance = 0;
    this.history = [];
    this.queue = Promise.resolve();
  }

  async init({ startCredit = 0 } = {}) {
    try {
      const data = JSON.parse(await fsp.readFile(this.path, 'utf8'));
      this.balance = Number(data.balance) || 0;
      this.history = Array.isArray(data.history) ? data.history : [];
      this.currency = data.currency || this.currency;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (startCredit > 0) await this.add(startCredit, { type: 'welcome', ref: 'welcome' });
    }
    return this;
  }

  persist() {
    this.queue = this.queue.then(async () => {
      const tmp = `${this.path}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ currency: this.currency, balance: this.balance, history: this.history }, null, 2));
      await fsp.rename(tmp, this.path);
    });
    return this.queue;
  }

  get() {
    return { currency: this.currency, balance: this.balance, history: this.history.slice(-50).reverse() };
  }

  hasRef(ref) {
    return Boolean(ref) && this.history.some((h) => h.ref === ref);
  }

  // Add credit (a top-up). Idempotent: the same ref (e.g. a Stripe session) is only booked once.
  async add(amountMinor, { type = 'purchase', ref = '', note = '' } = {}) {
    if (ref && this.hasRef(ref)) return false;
    this.balance += amountMinor;
    this.history.push({ at: new Date().toISOString(), type, amount: amountMinor, ref, note });
    await this.persist();
    return true;
  }

  // Before a Claude action: is there enough credit for a typical one?
  ensureFor(action) {
    const needed = priceMinor(TYPICAL_USD[action] || 0.05, this.currency);
    if (this.balance < needed) {
      throw new CreditError(402, 'Not enough credit for this. Top up your balance under Account.', 'no_credit', { needed, balance: this.balance, currency: this.currency });
    }
  }

  // After a Claude action: charge its real cost. The balance can dip slightly
  // below zero when an action costs more than usual; the next action is then refused.
  async charge(action, costUsd) {
    const amount = priceMinor(costUsd, this.currency);
    this.balance -= amount;
    this.history.push({ at: new Date().toISOString(), type: 'charge', action, amount: -amount, costUsd: Math.round(costUsd * 1e6) / 1e6 });
    if (this.history.length > 2000) this.history = this.history.slice(-2000);
    await this.persist();
    return amount;
  }
}

module.exports = { Credits, CreditError, priceMinor, priceList, PACKS, TYPICAL_USD, config };
