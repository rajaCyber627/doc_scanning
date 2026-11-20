jest.mock('../src/clients', () => require('./fakes/clients'));

const request = require('supertest');
const { startDb, clearDb, stopDb } = require('./helpers');
const { createApp } = require('../src/app');

const app = createApp();

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

const signup = (body) => request(app).post('/api/signup').send(body);
const login = (body) => request(app).post('/api/login').send(body);

describe('auth', () => {
  test('sign up and log in by email or username; password is never returned', async () => {
    const s = await signup({ firstName: 'A', userName: 'alice', email: 'alice@example.com', password: 'Secret123!' });
    expect(s.status).toBe(201);
    expect(s.body.userInfo.password).toBeUndefined();

    for (const id of ['alice@example.com', 'alice']) {
      const l = await login({ userNameorEmail: id, password: 'Secret123!' });
      expect(l.status).toBe(200);
      expect(l.body.userInfo.email).toBe('alice@example.com');
      expect(l.body.userInfo.password).toBeUndefined();
    }
  });

  test('wrong password → 401, unknown user → 404', async () => {
    await signup({ userName: 'alice', email: 'alice@example.com', password: 'Secret123!' });
    expect((await login({ userNameorEmail: 'alice', password: 'nope' })).status).toBe(401);
    expect((await login({ userNameorEmail: 'bob', password: 'Secret123!' })).status).toBe(404);
  });

  test('BUG FIX: login without a username/email is rejected (used to log in as the first user)', async () => {
    await signup({ userName: 'alice', email: 'alice@example.com', password: 'Secret123!' });
    for (const body of [
      { password: 'Secret123!' },
      { userNameorEmail: '', password: 'Secret123!' },
      { userNameorEmail: '   ', password: 'Secret123!' },
      { email: 'alice@example.com', password: 'Secret123!' }, // wrong field name
    ]) {
      const res = await login(body);
      expect(res.status).toBe(400);
      expect(res.body.userInfo).toBeUndefined();
    }
  });

  test('BUG FIX: sign-up without a username no longer collides with every existing user', async () => {
    await signup({ userName: 'alice', email: 'alice@example.com', password: 'Secret123!' });
    const res = await signup({ email: 'bob@example.com', password: 'Secret123!' });
    expect(res.status).toBe(201);
  });

  test('duplicate email or username is still rejected; missing email/password → 400', async () => {
    await signup({ userName: 'alice', email: 'alice@example.com', password: 'Secret123!' });
    expect((await signup({ userName: 'other', email: 'alice@example.com', password: 'x' })).status).toBe(400);
    expect((await signup({ userName: 'alice', email: 'new@example.com', password: 'x' })).status).toBe(400);
    expect((await signup({ userName: 'carol', password: 'x' })).status).toBe(400);
    expect((await signup({ userName: 'carol', email: 'carol@example.com' })).status).toBe(400);
  });
});
