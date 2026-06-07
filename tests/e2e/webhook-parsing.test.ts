import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import nock from 'nock';
import app from '../../src/app.js';
import { pool } from '../../src/db/connection.js';
import { cleanDatabase, seedClient } from '../helpers/db.js';
import { mockGeminiClient, mockTwilioClient } from '../setup.js';

const CLIENT_A = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Bella Hair Salon',
  meta_phone_number_id: '109927651347890',
  whatsapp_token: 'EAAGxx887766aaBBccDDeeFF',
  system_prompt: 'You are Bella, a friendly receptionist at Bella Hair Salon.',
  use_twilio: false,
  whatsapp_number: '+14155238886',
};

const CLIENT_B = {
  id: '6a2b8400-e29b-41d4-a716-446655440111',
  name: 'Apex Auto Repair',
  meta_phone_number_id: '209938762458901',
  whatsapp_token: 'EAAGyy998877bbCCddEEffGG',
  system_prompt: 'You are Apex Mechanic AI, a service writer.',
  use_twilio: true,
  whatsapp_number: '+14155238887',
};

describe('F4: Webhook Parsing & Routing E2E', () => {
  beforeEach(async () => {
    await cleanDatabase();
    nock.cleanAll();
    vi.clearAllMocks();
  });

  test('TC-4.1.1: Parse Twilio URL-encoded request', async () => {
    await seedClient(CLIENT_B); // Client B is configured for Twilio

    mockGeminiClient.models.generateContent.mockResolvedValueOnce({ text: 'query' });

    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('From=whatsapp%3A%2B12025550199&To=whatsapp%3A%2B14155238887&Body=Where+is+your+shop%3F&MessageSid=SM11111');

    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');

    // Wait a brief moment to let async handler finish if async
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify Gemini was called to classify intent
    expect(mockGeminiClient.models.generateContent).toHaveBeenCalled();
  });

  test('TC-4.1.2: Parse Meta JSON request', async () => {
    await seedClient(CLIENT_A); // Client A is configured for Meta

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' }) // intent
      .mockResolvedValueOnce({ text: 'We are located downtown.' }); // response

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(200, { messaging_product: 'whatsapp', contacts: [], messages: [] });

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '14155238886',
                  phone_number_id: CLIENT_A.meta_phone_number_id,
                },
                messages: [
                  {
                    from: '12025550199',
                    id: 'wamid.HBgLMTIwMjU1NTAxOTkVAgASGBQzQTA3QzBDN0RFQzQ4QzVDNkU5QjNBAA==',
                    timestamp: '1675903962',
                    text: { body: 'Where is your shop?' },
                    type: 'text',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const response = await request(app)
      .post('/webhook')
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);
  });

  test('TC-4.1.3: Immediate HTTP 200 Response', async () => {
    await seedClient(CLIENT_A);

    const response = await request(app)
      .post('/webhook')
      .send({
        object: 'whatsapp_business_account',
        entry: [{ id: '1', changes: [{ value: { messaging_product: 'whatsapp', metadata: { phone_number_id: CLIENT_A.meta_phone_number_id }, messages: [{ from: '12025550199', id: 'msg123', text: { body: 'Hi' }, type: 'text' }] }, field: 'messages' }] }],
      });

    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');

    await new Promise(resolve => setTimeout(resolve, 50));
  });

  test('TC-4.1.4: Tenant/Client Resolution', async () => {
    await seedClient(CLIENT_A);
    await seedClient(CLIENT_B);

    // Call for Client B (Twilio)
    mockGeminiClient.models.generateContent.mockResolvedValueOnce({ text: 'query' });

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp:+12025550199&To=whatsapp:${CLIENT_B.whatsapp_number}&Body=Hello&MessageSid=SM222`);

    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify conversation was created with client_id = CLIENT_B.id
    const res = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', ['+12025550199']);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].client_id).toBe(CLIENT_B.id);
  });

  test('TC-4.1.5: Route to Query Handler', async () => {
    await seedClient(CLIENT_A);

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' }) // intent
      .mockResolvedValueOnce({ text: 'Our policy is simple.' }); // response

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('Our policy is simple.');
      })
      .reply(200, { ok: true });

    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: '1',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: CLIENT_A.meta_phone_number_id },
            messages: [{
              from: '12025550199',
              id: 'msg_q',
              text: { body: 'What is your policy?' },
              type: 'text'
            }]
          },
          field: 'messages'
        }]
      }]
    };

    await request(app).post('/webhook').send(payload);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(metaScope.isDone()).toBe(true);
  });

  test('TC-4.2.1: Missing Critical Twilio Parameters', async () => {
    // Missing 'From'
    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('To=whatsapp%3A%2B14155238887&Body=Hello&MessageSid=SM111');

    expect(response.status).toBe(200); // Should handle gracefully and return 200
  });

  test('TC-4.2.2: Malformed Meta JSON Payload', async () => {
    // Malformed JSON (syntax error)
    const response1 = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send('{ malformed json }');
    expect(response1.status).toBe(400); // Express body-parser usually returns 400 for bad JSON syntax

    // Valid JSON but missing entry changes
    const response2 = await request(app)
      .post('/webhook')
      .send({ object: 'whatsapp_business_account' });
    expect(response2.status).toBe(200); // Returns 200 to satisfy webhook but doesn't crash
  });

  test('TC-4.2.3: Meta Subscription Verification challenge', async () => {
    const response = await request(app)
      .get('/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.challenge': '123456',
        'hub.verify_token': 'my_verify_token'
      });

    expect(response.status).toBe(200);
    expect(response.text).toBe('123456');
  });

  test('TC-4.2.4: Unregistered Client Request', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: '1',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '999999999999' }, // Unregistered phone ID
            messages: [{ from: '12025550199', id: 'msg_unreg', text: { body: 'Hello' }, type: 'text' }]
          },
          field: 'messages'
        }]
      }]
    };

    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200); // Returns 200
    // Gemini should not have been called
    expect(mockGeminiClient.models.generateContent).not.toHaveBeenCalled();
  });

  test('TC-4.2.5: Request Deduplication', async () => {
    await seedClient(CLIENT_A);

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' })
      .mockResolvedValueOnce({ text: 'Duplicate test response' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: '1',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: CLIENT_A.meta_phone_number_id },
            messages: [{ from: '12025550199', id: 'duplicate_msg_id', text: { body: 'Help' }, type: 'text' }]
          },
          field: 'messages'
        }]
      }]
    };

    // Send first request
    const response1 = await request(app).post('/webhook').send(payload);
    expect(response1.status).toBe(200);

    // Send second duplicate request immediately
    const response2 = await request(app).post('/webhook').send(payload);
    expect(response2.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));

    // Gemini should have been called only once for intent classification (or twice if not deduplicated, but we expect 1 for intent and 1 for response, so exactly 2 calls total)
    // Wait, let's verify if generateContent was called once or twice. If it processes only once, it should have 2 calls (1 for intent, 1 for response). If it processes twice, it would have 4 calls.
    expect(mockGeminiClient.models.generateContent).toHaveBeenCalledTimes(2);
  });
});
