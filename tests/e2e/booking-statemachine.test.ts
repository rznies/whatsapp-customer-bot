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

describe('F5: Booking State Machine E2E', () => {
  beforeEach(async () => {
    await cleanDatabase();
    nock.cleanAll();
    vi.clearAllMocks();
    await seedClient(CLIENT_A);
  });

  test('TC-5.1.1: Idle to Collecting Name State', async () => {
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' }) // intent
      .mockResolvedValueOnce({ text: 'What is your name?' }); // response

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('What is your name?');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload('I want to book an appointment', 'msg_511');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows.length).toBe(1);
    expect(convRes.rows[0].current_state).toBe('collecting_name');
  });

  test('TC-5.1.2: Collecting Name to Collecting Date', async () => {
    // Set up conversation state to 'collecting_name'
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ['770e8400-e29b-41d4-a716-446655440001', CUSTOMER_PHONE, CLIENT_A.id, 'collecting_name', '{}']
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' }) // intent
      .mockResolvedValueOnce({ text: 'When would you like to book?' }); // response

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('When would you like to book?');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload('Jane Smith', 'msg_512');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows[0].current_state).toBe('collecting_date');
    expect(convRes.rows[0].partial_booking_data.name).toBe('Jane Smith');
  });

  test('TC-5.1.3: Collecting Date to Collecting Service', async () => {
    // Set up conversation state to 'collecting_date' with name
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ['770e8400-e29b-41d4-a716-446655440002', CUSTOMER_PHONE, CLIENT_A.id, 'collecting_date', '{"name": "Jane Smith"}']
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' }) // intent (or parsing date logic)
      .mockResolvedValueOnce({ text: 'What service (haircut, color, styling)?' }); // response

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('What service (haircut, color, styling)?');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload('Friday at 2pm', 'msg_513');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows[0].current_state).toBe('collecting_service');
    expect(convRes.rows[0].partial_booking_data.date).toBe('Friday at 2pm');
  });

  test('TC-5.1.4: Collecting Service to Awaiting Confirmation', async () => {
    // Set up conversation state to 'collecting_service'
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ['770e8400-e29b-41d4-a716-446655440003', CUSTOMER_PHONE, CLIENT_A.id, 'collecting_service', '{"name": "Jane Smith", "date": "Friday at 2pm"}']
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'Do you confirm booking Haircut on Friday at 2pm for Jane Smith? Please reply Yes or No.' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('Jane Smith') && body.text.body.includes('Friday at 2pm') && body.text.body.includes('Haircut');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload('Haircut', 'msg_514');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows[0].current_state).toBe('awaiting_confirmation');
    expect(convRes.rows[0].partial_booking_data.service).toBe('Haircut');
  });

  test('TC-5.1.5: Confirm Booking (Flow Complete)', async () => {
    // Set up conversation state to 'awaiting_confirmation'
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ['770e8400-e29b-41d4-a716-446655440004', CUSTOMER_PHONE, CLIENT_A.id, 'awaiting_confirmation', '{"name": "Jane Smith", "date": "2026-06-07 14:00:00", "service": "Haircut"}']
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'Booking confirmed!' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('Booking confirmed');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload('Yes', 'msg_515');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    // Assert conversation state reset to idle
    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows[0].current_state).toBe('idle');
    expect(convRes.rows[0].partial_booking_data).toBeNull();

    // Assert booking created
    const bookingRes = await pool.query('SELECT * FROM bookings WHERE client_id = $1', [CLIENT_A.id]);
    expect(bookingRes.rows.length).toBe(1);
    expect(bookingRes.rows[0].customer_name).toBe('Jane Smith');
    expect(bookingRes.rows[0].service).toBe('Haircut');
    expect(bookingRes.rows[0].status).toBe('confirmed');

    // Assert follow-up scheduled
    const followupRes = await pool.query('SELECT * FROM follow_ups WHERE booking_id = $1', [bookingRes.rows[0].id]);
    expect(followupRes.rows.length).toBe(1);
    expect(followupRes.rows[0].sent).toBe(false);
  });

  test('TC-5.2.1: Invalid Date Format Handling', async () => {
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ['770e8400-e29b-41d4-a716-446655440005', CUSTOMER_PHONE, CLIENT_A.id, 'collecting_date', '{"name": "Jane Smith"}']
    );

    // System detects invalid date input (e.g. Gemini fails to extract or classifies as invalid)
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'Could you please specify a valid date and time?' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('Could you please specify a valid date and time?');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload('whenever you want', 'msg_521');
    const response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows[0].current_state).toBe('collecting_date'); // remains in collecting_date
  });

  test('TC-5.2.2: Unsupported Service Option', async () => {
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ['770e8400-e29b-41d4-a716-446655440006', CUSTOMER_PHONE, CLIENT_A.id, 'collecting_service', '{"name": "Jane Smith", "date": "Friday at 2pm"}']
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'Sorry, we only offer haircut, color, styling. Please select one.' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    const payload = makeMetaPayload('rocket launch', 'msg_522');
    await request(app).post('/webhook').send(payload);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows[0].current_state).toBe('collecting_service'); // remains in collecting_service
  });

  test('TC-5.2.3: Customer Cancellation mid-flow', async () => {
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ['770e8400-e29b-41d4-a716-446655440007', CUSTOMER_PHONE, CLIENT_A.id, 'collecting_date', '{"name": "Jane Smith"}']
    );

    // Cancel mid-flow (either Gemini classifies as booking/other but body contains cancel, or intent is cancel/other)
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'other' }) // or booking
      .mockResolvedValueOnce({ text: 'Booking cancelled.' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('Booking cancelled');
      })
      .reply(200, { ok: true });

    const payload = makeMetaPayload('cancel', 'msg_523');
    await request(app).post('/webhook').send(payload);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows[0].current_state).toBe('idle');
    expect(convRes.rows[0].partial_booking_data).toBeNull();
  });

  test('TC-5.2.4: Intent Switch Mid-booking Flow', async () => {
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ['770e8400-e29b-41d4-a716-446655440008', CUSTOMER_PHONE, CLIENT_A.id, 'collecting_name', '{}']
    );

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' }) // intent is classified as query
      .mockResolvedValueOnce({ text: 'Our prices start at $50. Now, what was your name?' }); // answers query, re-prompts for name

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    const payload = makeMetaPayload('What are your prices?', 'msg_524');
    await request(app).post('/webhook').send(payload);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows[0].current_state).toBe('collecting_name'); // preserves state
  });

  test('TC-5.2.5: Booking Flow Session Expiry (Timeout)', async () => {
    // Inactive conversation: last_messaged_at = 25 hours ago
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['770e8400-e29b-41d4-a716-446655440009', CUSTOMER_PHONE, CLIENT_A.id, 'collecting_date', '{"name": "Jane Smith"}', yesterday]
    );

    // Customer sends message, since expired, system resets state to idle and starts new booking flow
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'What is your name?' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    const payload = makeMetaPayload('I want to book', 'msg_525');
    await request(app).post('/webhook').send(payload);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convRes = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [CUSTOMER_PHONE]);
    expect(convRes.rows[0].current_state).toBe('collecting_name'); // state resets and starts over
    expect(convRes.rows[0].partial_booking_data).toEqual({}); // old data is wiped
  });
});
