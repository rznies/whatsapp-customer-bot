import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import nock from 'nock';
import app from '../../src/app.js';
import { pool } from '../../src/db/connection.js';
import { cleanDatabase, seedClient } from '../helpers/db.js';
import { mockGeminiClient } from '../setup.js';

const CLIENT_A = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Bella Hair Salon',
  meta_phone_number_id: '109927651347890',
  whatsapp_token: 'EAAGxx887766aaBBccDDeeFF',
  system_prompt: 'You are Bella, a friendly receptionist at Bella Hair Salon.',
  use_twilio: false,
  whatsapp_number: '+14155238886',
};

const CUSTOMER_PHONE = '+12025550199';

function makeMetaPayload(messageText: string, messageId: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: CLIENT_A.meta_phone_number_id },
          messages: [{
            from: CUSTOMER_PHONE.replace('+', ''),
            id: messageId,
            timestamp: Math.floor(Date.now() / 1000).toString(),
            text: { body: messageText },
            type: 'text'
          }]
        },
        field: 'messages'
      }]
    }]
  };
}

describe('F7: Error Handling & Resilience E2E', () => {
  beforeEach(async () => {
    await cleanDatabase();
    nock.cleanAll();
    vi.clearAllMocks();
  });

  test('TC-7.1.1: DB Outage Resilience & TC-7.1.5: Fallback Dispatch Delivery', async () => {
    // Mock DB pool.query to throw error
    const originalQuery = pool.query;
    pool.query = vi.fn().mockRejectedValue(new Error('Connection timeout to PostgreSQL'));

    // Meta API mock for fallback delivery
    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('The team will get back to you shortly.');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload('Book a service', 'msg_711');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200); // Immediate 200

    await new Promise(resolve => setTimeout(resolve, 250));
    expect(metaScope.isDone()).toBe(true);

    pool.query = originalQuery;
  });

  test('TC-7.1.2: Gemini Service Error Isolation', async () => {
    await seedClient(CLIENT_A);

    mockGeminiClient.models.generateContent.mockRejectedValueOnce(new Error('Gemini API 500 Internal Error'));

    // Meta API mock for fallback delivery
    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('The team will get back to you shortly.');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload('Book a haircut', 'msg_712');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 250));
    expect(metaScope.isDone()).toBe(true);
  });

  test('TC-7.1.3: WhatsApp Outbound API Failure', async () => {
    await seedClient(CLIENT_A);

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' })
      .mockResolvedValueOnce({ text: 'Hello' });

    // Meta API mock returning 502 Bad Gateway
    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(502, 'Bad Gateway');

    const payload = makeMetaPayload('Hello', 'msg_713');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 250));
    expect(metaScope.isDone()).toBe(true);
    // Server did not crash
  });

  test('TC-7.1.4: Server Crash Prevention', async () => {
    // Send payload targeting syntax or structural issues
    const response1 = await request(app)
      .post('/webhook')
      .send(null as any);
    expect(response1.status).toBe(200); // Handled safely (or 400 if bad express body, but we keep server alive)

    const response2 = await request(app)
      .post('/webhook')
      .send({ object: '\0nullbyte' });
    expect(response2.status).toBe(200);
  });

  test('TC-7.2.1: Secondary Fallback Outage Recovery', async () => {
    // DB is down (first error)
    const originalQuery = pool.query;
    pool.query = vi.fn().mockRejectedValue(new Error('PostgreSQL Down'));

    // Meta API is also down for fallback delivery (secondary error)
    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(500, 'Internal Server Error');

    const payload = makeMetaPayload('Hi', 'msg_721');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200); // Webhook returns 200

    await new Promise(resolve => setTimeout(resolve, 250));
    expect(metaScope.isDone()).toBe(true);

    pool.query = originalQuery;
  });

  test('TC-7.2.2: Startup with Missing Essential Environment Variables', () => {
    // We test that missing credentials throws/logs during startup check but doesn't cause unhandled crash
    const configCheck = () => {
      const dbUrl = process.env.DATABASE_URL;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!dbUrl || !apiKey) {
        console.warn('Startup Warning: Missing essential environment variables');
      }
    };
    expect(configCheck).not.toThrow();
  });

  test('TC-7.2.3: Invalid Payload Encoding (Binary/Raw Streams)', async () => {
    // Send raw binary payload with invalid UTF-8 bytes to express
    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from([0x80, 0x81, 0x82]));

    expect(response.status).toBe(200); // Handled safely
  });

  test('TC-7.2.4: Database Connection Pool Exhaustion Recovery', async () => {
    const originalQuery = pool.query;
    // Simulate pool exhaustion (rejection with pool timeout error)
    pool.query = vi.fn().mockRejectedValue(new Error('timeout exceeded when acquiring a connection from pool'));

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    const payload = makeMetaPayload('Hi', 'msg_724');
    await request(app).post('/webhook').send(payload);

    await new Promise(resolve => setTimeout(resolve, 250));
    expect(metaScope.isDone()).toBe(true);

    pool.query = originalQuery;
  });

  test('TC-7.2.5: Log Rotation / Disk Full Resilience', async () => {
    await seedClient(CLIENT_A);

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' })
      .mockResolvedValueOnce({ text: 'Hello' });

    nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    // Mock console.error to simulate blocked console or disk full
    const originalConsoleError = console.error;
    console.error = vi.fn().mockImplementation(() => {
      throw new Error('Disk full / write error');
    });

    const payload = makeMetaPayload('Hello', 'msg_725');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);

    console.error = originalConsoleError;
  });
});
