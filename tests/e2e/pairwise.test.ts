import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import nock from 'nock';
import app from '../../src/app.js';
import { pool } from '../../src/db/connection.js';
import { cleanDatabase, seedClient } from '../helpers/db.js';
import { mockGeminiClient, mockTwilioClient } from '../setup.js';
import { runFollowupJob } from '../../src/jobs/followup.cron.js';

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

function makeMetaPayload(phoneNumberId: string, fromNumber: string, messageText: string, messageId: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: phoneNumberId },
          messages: [{
            from: fromNumber.replace('+', ''),
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

describe('Tier 3: Pairwise Cross-Feature Combinations', () => {
  beforeEach(async () => {
    await cleanDatabase();
    nock.cleanAll();
    vi.clearAllMocks();
  });

  test('Case T3.1: Twilio Webhook x State Machine Confirmation', async () => {
    const client = {
      ...CLIENT_A,
      use_twilio: true,
      whatsapp_number: '+14155238886',
    };
    await seedClient(client);

    const customerPhone = '+12025550199';
    const conversationId = '770e8400-e29b-41d4-a716-446655440001';
    
    // Seed active conversation awaiting confirmation
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [conversationId, customerPhone, client.id, 'awaiting_confirmation', JSON.stringify({ name: 'Alice', service: 'Haircut', date: '2026-06-07 10:00:00' })]
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'Booking confirmed!' });

    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550199&To=whatsapp%3A%2B14155238886&Body=Yes%2C+confirm+it&MessageSid=SM301`);

    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');

    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert conversations updated
    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(convRes.rows[0].current_state).toBe('idle');
    expect(convRes.rows[0].partial_booking_data).toBeNull();

    // Assert bookings updated
    const bookingRes = await pool.query('SELECT * FROM bookings WHERE client_id = $1', [client.id]);
    expect(bookingRes.rows.length).toBe(1);
    expect(bookingRes.rows[0].customer_name).toBe('Alice');
    expect(bookingRes.rows[0].status).toBe('confirmed');

    // Assert follow_ups scheduled
    const fuRes = await pool.query('SELECT * FROM follow_ups WHERE booking_id = $1', [bookingRes.rows[0].id]);
    expect(fuRes.rows.length).toBe(1);
    expect(fuRes.rows[0].sent).toBe(false);

    // Assert Twilio SDK was called
    expect(mockTwilioClient.messages.create).toHaveBeenCalled();
  });

  test('Case T3.2: Meta Webhook x State Machine Query Interruption', async () => {
    const client = {
      ...CLIENT_B,
      use_twilio: false,
      meta_phone_number_id: '209938762458901',
    };
    await seedClient(client);

    const customerPhone = '+12025550299';
    const conversationId = '770e8400-e29b-41d4-a716-446655440002';
    
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [conversationId, customerPhone, client.id, 'collecting_date', JSON.stringify({ name: 'Bob' })]
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' })
      .mockResolvedValueOnce({ text: 'We are open from 9 AM to 6 PM.' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('open from 9 AM to 6 PM');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'What are your opening hours?', 'msg_302');
    const response = await request(app).post('/webhook').send(payload);

    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(convRes.rows[0].current_state).toBe('collecting_date');
    expect(convRes.rows[0].partial_booking_data.name).toBe('Bob');
  });

  test('Case T3.3: Twilio Webhook x Follow-up Cancellation', async () => {
    const client = {
      ...CLIENT_A,
      use_twilio: true,
      whatsapp_number: '+14155238886',
    };
    await seedClient(client);

    const customerPhone = '+12025550399';
    const bookingId = '880e8400-e29b-41d4-a716-446655440003';
    const followupId = '990e8400-e29b-41d4-a716-446655440003';

    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
      ['770e8400-e29b-41d4-a716-446655440003', customerPhone, client.id]
    );

    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
       VALUES ($1, $2, $3, $4, NOW(), 'confirmed')`,
      [bookingId, client.id, 'Alice', 'Haircut']
    );

    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours', false)`,
      [followupId, bookingId]
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'followup-cancel' })
      .mockResolvedValueOnce({ text: 'Your appointment has been cancelled.' });

    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550399&To=whatsapp%3A%2B14155238886&Body=Cancel+my+appointment+tomorrow+please&MessageSid=SM303`);

    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');

    await new Promise(resolve => setTimeout(resolve, 50));

    const bookingRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    expect(bookingRes.rows[0].status).toBe('cancelled');

    const fuRes = await pool.query('SELECT * FROM follow_ups WHERE id = $1', [followupId]);
    expect(fuRes.rows.length === 0 || fuRes.rows[0].sent === true).toBe(true);

    expect(mockTwilioClient.messages.create).toHaveBeenCalled();
  });

  test('Case T3.4: Meta Webhook x Gemini API Timeout Resilience', async () => {
    const client = {
      ...CLIENT_B,
      use_twilio: false,
      meta_phone_number_id: '209938762458901',
    };
    await seedClient(client);

    const customerPhone = '+12025550499';
    const conversationId = '770e8400-e29b-41d4-a716-446655440004';

    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'collecting_name', '{}', NOW())`,
      [conversationId, customerPhone, client.id]
    );

    mockGeminiClient.models.generateContent.mockRejectedValueOnce(new Error('Gemini API Timeout'));

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('The team will get back to you shortly');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'I want to book', 'msg_304');
    const response = await request(app).post('/webhook').send(payload);

    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(convRes.rows[0].current_state).toBe('collecting_name');
  });

  test('Case T3.5: Multi-Tenant State Isolation (Twilio vs Meta Cross-Talk)', async () => {
    const clientA = {
      ...CLIENT_A,
      use_twilio: true,
      whatsapp_number: '+14155238886',
    };
    const clientB = {
      ...CLIENT_B,
      use_twilio: false,
      meta_phone_number_id: '209938762458901',
    };
    await seedClient(clientA);
    await seedClient(clientB);

    const customerPhone = '+12025550599';

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'What is your name?' });

    const twilioResponse = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550599&To=whatsapp%3A%2B14155238886&Body=Start+booking&MessageSid=SM305a`);

    expect(twilioResponse.status).toBe(200);

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' })
      .mockResolvedValueOnce({ text: 'Hello! Zen Yoga Studio here.' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${clientB.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('Zen Yoga Studio here');
      })
      .reply(200, { ok: true });

    const metaPayload = makeMetaPayload(clientB.meta_phone_number_id, customerPhone, 'Hello', 'msg_305b');
    const metaResponse = await request(app).post('/webhook').send(metaPayload);

    expect(metaResponse.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(metaScope.isDone()).toBe(true);
    expect(mockTwilioClient.messages.create).toHaveBeenCalled();

    const convA = await pool.query('SELECT * FROM conversations WHERE client_id = $1 AND customer_phone_number = $2', [clientA.id, customerPhone]);
    expect(convA.rows[0].current_state).toBe('collecting_name');

    const convB = await pool.query('SELECT * FROM conversations WHERE client_id = $1 AND customer_phone_number = $2', [clientB.id, customerPhone]);
    expect(convB.rows[0].current_state).toBe('idle');
  });

  test('Case T3.6: Booking Confirmation x Graph API HTTP Failure Handling', async () => {
    const client = {
      ...CLIENT_B,
      use_twilio: false,
      meta_phone_number_id: '209938762458901',
      whatsapp_token: 'EXPIRED_TOKEN',
    };
    await seedClient(client);

    const customerPhone = '+12025550699';
    const conversationId = '770e8400-e29b-41d4-a716-446655440006';

    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [conversationId, customerPhone, client.id, 'awaiting_confirmation', JSON.stringify({ name: 'Bob', service: 'Oil Change', date: '2026-06-07 10:00:00' })]
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'Booking confirmed!' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`)
      .reply(401, { error: { message: 'Invalid OAuth access token' } });

    const payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'Confirm', 'msg_306');
    const response = await request(app).post('/webhook').send(payload);

    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(convRes.rows[0].current_state).toBe('idle');

    const bookingRes = await pool.query('SELECT * FROM bookings WHERE client_id = $1', [client.id]);
    expect(bookingRes.rows.length).toBe(1);
    expect(bookingRes.rows[0].customer_name).toBe('Bob');
  });

  test('Case T3.7: Follow-up Cron x Multi-Provider Destination Mix', async () => {
    const clientA = {
      ...CLIENT_A,
      use_twilio: true,
      whatsapp_number: '+14155238886',
    };
    const clientB = {
      ...CLIENT_B,
      use_twilio: false,
      meta_phone_number_id: '209938762458901',
    };
    await seedClient(clientA);
    await seedClient(clientB);

    const bookingAId = '880e8400-e29b-41d4-a716-44665544007a';
    const bookingBId = '880e8400-e29b-41d4-a716-44665544007b';

    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
       VALUES ($1, $2, 'Alice', 'Haircut', NOW(), 'confirmed'),
              ($3, $4, 'Bob', 'Oil Change', NOW(), 'confirmed')`,
      [bookingAId, clientA.id, bookingBId, clientB.id]
    );

    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ('770e8400-e29b-41d4-a716-44665544007a', '+12025550701', $1, 'idle', '{}', NOW()),
              ('770e8400-e29b-41d4-a716-44665544007b', '+12025550702', $2, 'idle', '{}', NOW())`,
      [clientA.id, clientB.id]
    );

    const expiredTime = new Date(Date.now() - 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ('990e8400-e29b-41d4-a716-44665544007a', $1, $2, false),
              ('990e8400-e29b-41d4-a716-44665544007b', $3, $2, false)`,
      [bookingAId, expiredTime, bookingBId]
    );

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${clientB.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    await runFollowupJob();

    expect(metaScope.isDone()).toBe(true);
    expect(mockTwilioClient.messages.create).toHaveBeenCalled();

    const fuA = await pool.query('SELECT sent FROM follow_ups WHERE id = $1', ['990e8400-e29b-41d4-a716-44665544007a']);
    expect(fuA.rows[0].sent).toBe(true);

    const fuB = await pool.query('SELECT sent FROM follow_ups WHERE id = $1', ['990e8400-e29b-41d4-a716-44665544007b']);
    expect(fuB.rows[0].sent).toBe(true);
  });

  test('Case T3.8: Adversarial Validation in State Machine', async () => {
    const client = {
      ...CLIENT_A,
      use_twilio: false,
      meta_phone_number_id: '109927651347890',
    };
    await seedClient(client);

    const customerPhone = '+12025550899';
    const conversationId = '770e8400-e29b-41d4-a716-446655440008';

    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'collecting_date', '{"name": "Alice"}', NOW())`,
      [conversationId, customerPhone, client.id]
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: "Sorry, I couldn't understand that date. Could you please provide a valid date and time?" });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes("couldn't understand that date");
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'blah blah', 'msg_308');
    const response = await request(app).post('/webhook').send(payload);

    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(convRes.rows[0].current_state).toBe('collecting_date');
  });

  test('Case T3.9: Query Intent x Custom Tenant Prompts', async () => {
    const clientA = {
      ...CLIENT_A,
      system_prompt: 'You are a helpful assistant speaking like a pirate.',
      use_twilio: false,
      meta_phone_number_id: '109927651347890',
    };
    const clientB = {
      ...CLIENT_B,
      system_prompt: 'You are a professional medical receptionist.',
      use_twilio: false,
      meta_phone_number_id: '209938762458901',
    };
    await seedClient(clientA);
    await seedClient(clientB);

    const customerPhone = '+12025550999';

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' })
      .mockResolvedValueOnce({ text: "Ahoy! Our policy is..." });

    const metaScopeA = nock('https://graph.facebook.com')
      .post(`/v17.0/${clientA.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('Ahoy');
      })
      .reply(200, { ok: true });

    const payloadA = makeMetaPayload(clientA.meta_phone_number_id, customerPhone, 'What is your policy?', 'msg_309a');
    await request(app).post('/webhook').send(payloadA);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScopeA.isDone()).toBe(true);

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' })
      .mockResolvedValueOnce({ text: "Our clinic policy dictates..." });

    const metaScopeB = nock('https://graph.facebook.com')
      .post(`/v17.0/${clientB.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('Our clinic policy dictates');
      })
      .reply(200, { ok: true });

    const payloadB = makeMetaPayload(clientB.meta_phone_number_id, customerPhone, 'What is your policy?', 'msg_309b');
    await request(app).post('/webhook').send(payloadB);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScopeB.isDone()).toBe(true);
  });

  test('Case T3.10: Database Timeout Resilience during Message Processing', async () => {
    const client = {
      ...CLIENT_A,
      use_twilio: false,
      meta_phone_number_id: '109927651347890',
    };
    await seedClient(client);

    const customerPhone = '+12025551099';

    const originalQuery = pool.query;
    pool.query = vi.fn().mockRejectedValue(new Error('Connection timeout'));

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('The team will get back to you shortly');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'I want to book', 'msg_310');
    
    try {
      const response = await request(app).post('/webhook').send(payload);
      expect(response.status).toBe(200);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(metaScope.isDone()).toBe(true);
    } finally {
      pool.query = originalQuery;
    }
  });
});
