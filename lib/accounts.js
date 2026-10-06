'use strict';

// User accounts for the hosted version (MULTI_USER=1): e-mail + password,
// sessions in an HttpOnly cookie. Passwords are hashed with scrypt; session
// tokens are stored only as SHA-256 hashes.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 10; // per e-mail and per IP, within ATTEMPT_WINDOW_MS
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

class AccountError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = await scrypt(String(password), salt, 64);
  return { salt, hash: key.toString('hex') };
}

class Accounts {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, 'accounts.json');
    this.users = [];
    this.sessions = {}; // sha256(token) -> { userId, expires }
    this.attempts = new Map(); // key -> [timestamps]
    this.queue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      const data = JSON.parse(await fsp.readFile(this.path, 'utf8'));
      this.users = Array.isArray(data.users) ? data.users : [];
      this.sessions = data.sessions && typeof data.sessions === 'object' ? data.sessions : {};
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this.pruneSessions();
    return this;
  }

  persist() {
    this.queue = this.queue.then(async () => {
      const tmp = `${this.path}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ users: this.users, sessions: this.sessions }, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, this.path);
    });
    return this.queue;
  }

  pruneSessions() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.sessions)) if (s.expires < now) delete this.sessions[k];
  }

  // Slow down password guessing: too many tries for an e-mail or from an address are refused for a while.
  checkAttempts(...keys) {
    const now = Date.now();
    for (const key of keys) {
      const recent = (this.attempts.get(key) || []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
      this.attempts.set(key, recent);
      if (recent.length >= MAX_ATTEMPTS) throw new AccountError(429, 'Too many attempts. Wait 15 minutes and try again.', 'too_many_attempts');
    }
  }

  noteFailure(...keys) {
    for (const key of keys) this.attempts.set(key, [...(this.attempts.get(key) || []), Date.now()]);
  }

  publicUser(u) {
    return u ? { id: u.id, email: u.email, currency: u.currency, country: u.country, createdAt: u.createdAt } : null;
  }

  findById(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  async register({ email, password, country }, ip = '') {
    const mail = normEmail(email);
    this.checkAttempts(`ip:${ip}`);
    if (!validEmail(mail)) throw new AccountError(400, 'Enter a valid e-mail address.', 'invalid_email');
    if (String(password || '').length < 8) throw new AccountError(400, 'The password needs at least 8 characters.', 'weak_password');
    if (this.users.some((u) => u.email === mail)) {
      this.noteFailure(`ip:${ip}`);
      throw new AccountError(409, 'There is already an account with this e-mail address. Log in instead.', 'email_taken');
    }
    const cc = ['DE', 'AT', 'CH'].includes(country) ? country : 'DE';
    const { salt, hash } = await hashPassword(password);
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      email: mail,
      salt,
      hash,
      country: cc,
      currency: cc === 'CH' ? 'CHF' : 'EUR',
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    await this.persist();
    return user;
  }

  async login({ email, password }, ip = '') {
    const mail = normEmail(email);
    this.checkAttempts(`ip:${ip}`, `mail:${mail}`);
    const user = this.users.find((u) => u.email === mail);
    // Hash even when the user doesn't exist, so timing doesn't reveal which e-mails have accounts.
    const { hash } = await hashPassword(password, user ? user.salt : 'no-such-user');
    const ok = user && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
    if (!ok) {
      this.noteFailure(`ip:${ip}`, `mail:${mail}`);
      throw new AccountError(401, 'E-mail or password is wrong.', 'wrong_login');
    }
    return user;
  }

  async createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[sha256(token)] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 86400000 };
    this.pruneSessions();
    await this.persist();
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  userForToken(token) {
    if (!token) return null;
    const s = this.sessions[sha256(token)];
    if (!s || s.expires < Date.now()) return null;
    return this.findById(s.userId);
  }

  async endSession(token) {
    if (!token) return;
    delete this.sessions[sha256(token)];
    await this.persist();
  }

  // Delete an account (the caller removes the user's data folder).
  async remove(userId, password) {
    const user = this.findById(userId);
    if (!user) return false;
    const { hash } = await hashPassword(password, user.salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))) {
      throw new AccountError(401, 'The password is wrong.', 'wrong_password');
    }
    this.users = this.users.filter((u) => u.id !== userId);
    for (const [k, s] of Object.entries(this.sessions)) if (s.userId === userId) delete this.sessions[k];
    await this.persist();
    return true;
  }
}

module.exports = { Accounts, AccountError };
