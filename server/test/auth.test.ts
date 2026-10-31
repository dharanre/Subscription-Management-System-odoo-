import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db.js';
import { passwordProblems } from '../src/lib/password.js';
import { ADMIN, GOOD_PASSWORD, STAFF, type TestApp, buildTestApp, lastResetToken, loginAs, signupCustomer } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await buildTestApp();
});

describe('password rules', () => {
  it.each([
    ['Short#1a', 'needs more than 8 characters (exactly 8 is not enough)'],
    ['alllowercase#9', 'needs an uppercase letter'],
    ['ALLUPPERCASE#9', 'needs a lowercase letter'],
    ['NoSpecialChars99', 'needs a special character'],
  ])('rejects %s', (password) => {
    expect(passwordProblems(password).length).toBeGreaterThan(0);
  });

  it('accepts nine characters with upper, lower and a special character', () => {
    expect(passwordProblems('Abcdefg#h')).toEqual([]);
  });

  it('rejects passwords longer than bcrypt can read instead of truncating them', () => {
    expect(passwordProblems(`Aa#${'x'.repeat(80)}`)).toContain('No more than 72 bytes');
  });
});

describe('signup', () => {
  it('creates a customer account and signs the user in', async () => {
    const agent = request.agent(t.app);
    const res = await agent.post('/api/auth/signup').send({ name: 'Ravi', company: 'Ravi Stores', email: 'Ravi@Shop.example', password: GOOD_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ravi@shop.example', role: 'customer' });
    expect(res.body.user.password_hash).toBeUndefined();
    expect((await agent.get('/api/auth/me')).body.user.email).toBe('ravi@shop.example');

    const customer = get<{ name: string; company: string }>(t.db, 'SELECT name, company FROM customers WHERE email = ?', 'ravi@shop.example');
    expect(customer).toMatchObject({ name: 'Ravi', company: 'Ravi Stores' });
  });

  it('never stores the plain password', async () => {
    await signupCustomer(t, 'hash@shop.example');
    const row = get<{ password_hash: string }>(t.db, 'SELECT password_hash FROM users WHERE email = ?', 'hash@shop.example')!;
    expect(row.password_hash).not.toContain(GOOD_PASSWORD);
    expect(row.password_hash.startsWith('$2')).toBe(true);
  });

  it('allows each email to belong to only one account, ignoring case', async () => {
    await signupCustomer(t, 'dupe@shop.example');
    const res = await request(t.app).post('/api/auth/signup').send({ name: 'Other', email: 'DUPE@shop.example', password: GOOD_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.fields.email).toBeTruthy();
  });

  it('cannot be used to self-assign a privileged role', async () => {
    const res = await request(t.app).post('/api/auth/signup').send({ name: 'Mallory', email: 'm@shop.example', password: GOOD_PASSWORD, role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('customer');
  });

  it('reports field-level validation errors', async () => {
    const res = await request(t.app).post('/api/auth/signup').send({ name: '', email: 'not-an-email', password: 'weak' });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(['email', 'name', 'password']);
  });

  it('rejects a non-JSON body without crashing', async () => {
    const res = await request(t.app).post('/api/auth/signup').set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });
});

describe('login and sessions', () => {
  it('signs in with valid credentials and rejects wrong ones with the same message', async () => {
    const ok = await request(t.app).post('/api/auth/login').send({ email: ADMIN, password: 'Demo#Pass2026' });
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie']?.[0]).toMatch(/HttpOnly/i);

    const wrongPassword = await request(t.app).post('/api/auth/login').send({ email: ADMIN, password: 'Wrong#Pass2026' });
    const unknownUser = await request(t.app).post('/api/auth/login').send({ email: 'nobody@brightloop.example', password: 'Wrong#Pass2026' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('requires a session for /me and ends it on logout', async () => {
    const anonymous = await request(t.app).get('/api/auth/me');
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toEqual({ user: null });
    const agent = await loginAs(t, ADMIN);
    expect((await agent.get('/api/auth/me')).body.user.email).toBe(ADMIN);
    expect((await agent.post('/api/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/auth/me')).body.user).toBeNull();
  });

  it('rejects an expired session', async () => {
    const agent = await loginAs(t, ADMIN);
    run(t.db, 'UPDATE sessions SET expires_at = ?', new Date(Date.now() - 1000).toISOString());
    expect((await agent.get('/api/auth/me')).body.user).toBeNull();
  });

  it('refuses cross-site state-changing requests', async () => {
    const res = await request(t.app).post('/api/auth/logout').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    // a lookalike of the real app origin is still a different origin
    expect((await request(t.app).post('/api/auth/logout').set('Origin', 'http://localhost:5173.evil.example')).status).toBe(403);
    expect((await request(t.app).post('/api/auth/logout').set('Origin', 'http://localhost:9999')).status).toBe(403);
  });

  it('accepts writes from the configured web app origin even though a dev proxy changes the Host header', async () => {
    const proxied = (origin: string) =>
      request(t.app).post('/api/auth/login').set('Host', 'localhost:4000').set('Origin', origin).send({ email: ADMIN, password: 'Demo#Pass2026' });
    expect((await proxied('http://localhost:5173')).status).toBe(200);
    expect((await proxied('http://127.0.0.1:5173')).status).toBe(200);
    expect((await proxied('https://evil.example')).status).toBe(403);
  });
});

describe('role-based access to staff management', () => {
  const newStaff = { name: 'New Staffer', email: 'new.staff@brightloop.example', password: GOOD_PASSWORD };

  it('lets only the admin add staff', async () => {
    expect((await request(t.app).post('/api/users/staff').send(newStaff)).status).toBe(401);
    expect((await (await loginAs(t, STAFF)).post('/api/users/staff').send(newStaff)).status).toBe(403);
    expect((await (await signupCustomer(t, 'c@shop.example')).post('/api/users/staff').send(newStaff)).status).toBe(403);

    const res = await (await loginAs(t, ADMIN)).post('/api/users/staff').send(newStaff);
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('staff');
    expect(res.body.user.created_by).toBeUndefined();
    const row = get<{ created_by: number }>(t.db, 'SELECT created_by FROM users WHERE email = ?', newStaff.email)!;
    expect(row.created_by).toBeTruthy();
  });

  it('applies the password rules and email uniqueness to staff too', async () => {
    const admin = await loginAs(t, ADMIN);
    expect((await admin.post('/api/users/staff').send({ ...newStaff, password: 'weakpass' })).status).toBe(422);
    expect((await admin.post('/api/users/staff').send({ ...newStaff, email: STAFF })).status).toBe(409);
  });

  it('keeps the account list admin-only and paginated', async () => {
    expect((await (await loginAs(t, STAFF)).get('/api/users')).status).toBe(403);
    const res = await (await loginAs(t, ADMIN)).get('/api/users?pageSize=2&page=1');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.items[0].passwordHash).toBeUndefined();
  });

  it('signs a deactivated staff member out and blocks login, and protects the admin from self-lockout', async () => {
    const admin = await loginAs(t, ADMIN);
    const staff = await loginAs(t, STAFF);
    const staffId = get<{ id: number }>(t.db, 'SELECT id FROM users WHERE email = ?', STAFF)!.id;
    const adminId = get<{ id: number }>(t.db, 'SELECT id FROM users WHERE email = ?', ADMIN)!.id;

    expect((await admin.patch(`/api/users/${adminId}/status`).send({ isActive: false })).status).toBe(400);
    expect((await admin.patch(`/api/users/${staffId}/status`).send({ isActive: false })).status).toBe(200);
    expect((await staff.get('/api/auth/me')).body.user).toBeNull();
    expect((await request(t.app).post('/api/auth/login').send({ email: STAFF, password: 'Demo#Pass2026' })).status).toBe(401);
  });
});

describe('password reset', () => {
  it('emails a link without exposing the token in any API response', async () => {
    const res = await request(t.app).post('/api/auth/forgot').send({ email: STAFF });
    expect(res.status).toBe(202);
    const token = lastResetToken(t.mailer);
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(t.mailer.sent.at(-1)?.to).toBe(STAFF);
  });

  it('stores only a hash of the token', async () => {
    await request(t.app).post('/api/auth/forgot').send({ email: STAFF });
    const token = lastResetToken(t.mailer);
    const rows = all<{ token_hash: string }>(t.db, 'SELECT token_hash FROM password_resets');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
  });

  it('answers identically for unknown emails and sends nothing', async () => {
    const known = await request(t.app).post('/api/auth/forgot').send({ email: STAFF });
    const sentBefore = t.mailer.sent.length;
    const unknown = await request(t.app).post('/api/auth/forgot').send({ email: 'ghost@brightloop.example' });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(t.mailer.sent.length).toBe(sentBefore);
  });

  it('sets a new password, works once, and signs out existing sessions', async () => {
    const oldSession = await loginAs(t, STAFF);
    await request(t.app).post('/api/auth/forgot').send({ email: STAFF });
    const token = lastResetToken(t.mailer);

    const weak = await request(t.app).post('/api/auth/reset').send({ token, password: 'weak' });
    expect(weak.status).toBe(422);

    const ok = await request(t.app).post('/api/auth/reset').send({ token, password: 'Brand#New123' });
    expect(ok.status).toBe(200);
    expect((await oldSession.get('/api/auth/me')).body.user).toBeNull();
    expect((await request(t.app).post('/api/auth/login').send({ email: STAFF, password: 'Demo#Pass2026' })).status).toBe(401);
    expect((await request(t.app).post('/api/auth/login').send({ email: STAFF, password: 'Brand#New123' })).status).toBe(200);

    const reuse = await request(t.app).post('/api/auth/reset').send({ token, password: 'Another#Pass99' });
    expect(reuse.status).toBe(400);
  });

  it('rejects expired and unknown tokens', async () => {
    await request(t.app).post('/api/auth/forgot').send({ email: STAFF });
    const token = lastResetToken(t.mailer);
    run(t.db, 'UPDATE password_resets SET expires_at = ?', new Date(Date.now() - 1000).toISOString());
    expect((await request(t.app).post('/api/auth/reset').send({ token, password: 'Brand#New123' })).status).toBe(400);
    expect((await request(t.app).post('/api/auth/reset').send({ token: 'made-up', password: 'Brand#New123' })).status).toBe(400);
  });

  it('invalidates the previous link when a new one is requested', async () => {
    await request(t.app).post('/api/auth/forgot').send({ email: STAFF });
    const first = lastResetToken(t.mailer);
    await request(t.app).post('/api/auth/forgot').send({ email: STAFF });
    const second = lastResetToken(t.mailer);
    expect((await request(t.app).post('/api/auth/reset').send({ token: first, password: 'Brand#New123' })).status).toBe(400);
    expect((await request(t.app).post('/api/auth/reset').send({ token: second, password: 'Brand#New123' })).status).toBe(200);
  });
});
