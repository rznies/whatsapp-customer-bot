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

describe('Tier 4: Real-World Integration Scenarios', () => {
  beforeEach(async () => {
    await cleanDatabase();
    nock.cleanAll();
    vi.clearAllMocks();
  });

  test('Scenario T4.1: The Complete Booking & Follow-Up Lifecycle (Happy Path)', async () => {
    const client = {
      ...CLIENT_B,
      use_twilio: true,
      whatsapp_number: '+14155238887',
    };
    await seedClient(client);
    const customerPhone = '+12025550199';

    // Step 1: "Hey, I'd like to book an appointment"
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'What is your name?' });

    let response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550199&To=whatsapp%3A%2B14155238887&Body=Hey%2C+I%27d+like+to+book+an+appointment&MessageSid=SM411`);

    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    
    let conv = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(conv.rows[0].current_state).toBe('collecting_name');
    expect(mockTwilioClient.messages.create).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'What is your name?' }));

    // Step 2: "Alice"
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'When would you like to book?' });

    response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550199&To=whatsapp%3A%2B14155238887&Body=Alice&MessageSid=SM412`);

    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    
    conv = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(conv.rows[0].current_state).toBe('collecting_date');
    expect(conv.rows[0].partial_booking_data.name).toBe('Alice');
    expect(mockTwilioClient.messages.create).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'When would you like to book?' }));

    // Step 3: "Tomorrow at 10 AM"
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'What service (haircut, color, styling)?' });

    response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550199&To=whatsapp%3A%2B14155238887&Body=Tomorrow+at+10+AM&MessageSid=SM413`);

    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    
    conv = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(conv.rows[0].current_state).toBe('collecting_service');
    expect(conv.rows[0].partial_booking_data.date).toBeDefined();
    expect(mockTwilioClient.messages.create).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'What service (haircut, color, styling)?' }));

    // Step 4: "Haircut"
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'Do you confirm booking Haircut on Tomorrow at 10 AM for Alice? Please reply Yes or No.' });

    response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550199&To=whatsapp%3A%2B14155238887&Body=Haircut&MessageSid=SM414`);

    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    
    conv = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(conv.rows[0].current_state).toBe('awaiting_confirmation');
    expect(conv.rows[0].partial_booking_data.service).toBe('Haircut');

    // Step 5: "Yes please"
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'Booking confirmed!' });

    response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550199&To=whatsapp%3A%2B14155238887&Body=Yes+please&MessageSid=SM415`);

    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));

    conv = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(conv.rows[0].current_state).toBe('idle');
    expect(conv.rows[0].partial_booking_data).toBeNull();

    const bookings = await pool.query('SELECT * FROM bookings WHERE client_id = $1', [client.id]);
    expect(bookings.rows.length).toBe(1);
    expect(bookings.rows[0].customer_name).toBe('Alice');
    expect(bookings.rows[0].service).toBe('Haircut');
    expect(bookings.rows[0].status).toBe('confirmed');

    const followups = await pool.query('SELECT * FROM follow_ups WHERE booking_id = $1', [bookings.rows[0].id]);
    expect(followups.rows.length).toBe(1);
    expect(followups.rows[0].sent).toBe(false);

    // Step 6: Cron Execution (Fast forward 24h)
    const pastTime = new Date(Date.now() - 30 * 60 * 1000);
    await pool.query('UPDATE follow_ups SET scheduled_time = $1 WHERE booking_id = $2', [pastTime, bookings.rows[0].id]);

    await runFollowupJob();

    const updatedFollowups = await pool.query('SELECT * FROM follow_ups WHERE booking_id = $1', [bookings.rows[0].id]);
    expect(updatedFollowups.rows[0].sent).toBe(true);
    expect(mockTwilioClient.messages.create).toHaveBeenCalledTimes(6);
  });

  test('Scenario T4.2: Booking Flow Interrupted by Client-Specific Queries', async () => {
    const client = {
      ...CLIENT_A,
      use_twilio: false,
      meta_phone_number_id: '109927651347890',
    };
    await seedClient(client);
    const customerPhone = '+12025550299';

    // Step 1: "Book a haircut"
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'What is your name?' });

    const metaScope1 = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    let payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'Book a haircut', 'msg_421');
    let response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope1.isDone()).toBe(true);

    let conv = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(conv.rows[0].current_state).toBe('collecting_name');

    // Step 2: "Wait, do you guys have parking spaces?"
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'query' })
      .mockResolvedValueOnce({ text: 'Yes, we have free parking in the back.' });

    const metaScope2 = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('free parking');
      })
      .reply(200, { ok: true });

    payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'Wait, do you guys have parking spaces?', 'msg_422');
    response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope2.isDone()).toBe(true);

    conv = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(conv.rows[0].current_state).toBe('collecting_name');

    // Step 3: "Okay cool, my name is Bob"
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'When would you like to book?' });

    const metaScope3 = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'Okay cool, my name is Bob', 'msg_423');
    response = await request(app).post('/webhook').send(payload);
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope3.isDone()).toBe(true);

    conv = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(conv.rows[0].current_state).toBe('collecting_date');
    expect(conv.rows[0].partial_booking_data.name).toBe('Bob');
  });

  test('Scenario T4.3: Multi-Tenant Isolation & Simultaneous Sessions', async () => {
    const clientA = {
      ...CLIENT_A,
      use_twilio: false,
      meta_phone_number_id: '109927651347890',
    };
    const clientB = {
      ...CLIENT_B,
      use_twilio: true,
      whatsapp_number: '+14155238887',
    };
    await seedClient(clientA);
    await seedClient(clientB);
    const customerPhone = '+12025550399';

    // Step 1: User message to Client A
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'What is your name?' });

    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${clientA.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    let payloadA = makeMetaPayload(clientA.meta_phone_number_id, customerPhone, 'I want a haircut', 'msg_431');
    let response = await request(app).post('/webhook').send(payloadA);
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope.isDone()).toBe(true);

    const convA1 = await pool.query('SELECT * FROM conversations WHERE client_id = $1 AND customer_phone_number = $2', [clientA.id, customerPhone]);
    expect(convA1.rows[0].current_state).toBe('collecting_name');

    // Step 2: User message to Client B
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'What is your name?' });

    response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550399&To=whatsapp%3A%2B14155238887&Body=I+need+to+fix+my+car&MessageSid=SM432`);

    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mockTwilioClient.messages.create).toHaveBeenCalled();

    const convB1 = await pool.query('SELECT * FROM conversations WHERE client_id = $1 AND customer_phone_number = $2', [clientB.id, customerPhone]);
    expect(convB1.rows[0].current_state).toBe('collecting_name');

    // Step 3: User message to Client A (reply "Alice")
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'When would you like to book?' });

    const metaScope2 = nock('https://graph.facebook.com')
      .post(`/v17.0/${clientA.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    payloadA = makeMetaPayload(clientA.meta_phone_number_id, customerPhone, 'Alice', 'msg_433');
    response = await request(app).post('/webhook').send(payloadA);
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope2.isDone()).toBe(true);

    const convA2 = await pool.query('SELECT * FROM conversations WHERE client_id = $1 AND customer_phone_number = $2', [clientA.id, customerPhone]);
    expect(convA2.rows[0].current_state).toBe('collecting_date');
    expect(convA2.rows[0].partial_booking_data.name).toBe('Alice');

    const convB2 = await pool.query('SELECT * FROM conversations WHERE client_id = $1 AND customer_phone_number = $2', [clientB.id, customerPhone]);
    expect(convB2.rows[0].current_state).toBe('collecting_name');
    expect(convB2.rows[0].partial_booking_data).toEqual({});
  });

  test('Scenario T4.4: Confirmed Booking Cancelled via WhatsApp', async () => {
    const client = {
      ...CLIENT_B,
      use_twilio: true,
      whatsapp_number: '+14155238887',
    };
    await seedClient(client);
    const customerPhone = '+12025550499';
    const bookingId = '880e8400-e29b-41d4-a716-446655440004';
    const followupId = '990e8400-e29b-41d4-a716-446655440004';

    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ('770e8400-e29b-41d4-a716-446655440004', $1, $2, 'idle', '{}', NOW())`,
      [customerPhone, client.id]
    );

    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status, conversation_id)
       VALUES ($1, $2, 'Alice', 'Haircut', NOW() + INTERVAL '24 hours', 'confirmed', $3)`,
      [bookingId, client.id, '770e8400-e29b-41d4-a716-446655440004']
    );

    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours', false)`,
      [followupId, bookingId]
    );

    // Step 2: Customer sends "Cancel my appointment tomorrow"
    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'followup-cancel' })
      .mockResolvedValueOnce({ text: 'Your appointment has been cancelled.' });

    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`From=whatsapp%3A%2B12025550499&To=whatsapp%3A%2B14155238887&Body=Cancel+my+appointment+tomorrow&MessageSid=SM441`);

    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));

    const bookingRes = await pool.query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(bookingRes.rows[0].status).toBe('cancelled');

    const fuRes = await pool.query('SELECT * FROM follow_ups WHERE id = $1', [followupId]);
    expect(fuRes.rows.length === 0 || fuRes.rows[0].sent === true).toBe(true);

    expect(mockTwilioClient.messages.create).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('cancelled') }));

    // Step 3: Cron execution
    mockTwilioClient.messages.create.mockClear();

    await runFollowupJob();

    expect(mockTwilioClient.messages.create).not.toHaveBeenCalled();
  });

  test('Scenario T4.5: Webhook Endpoint Resiliency and Recovery', async () => {
    const client = {
      ...CLIENT_A,
      use_twilio: false,
      meta_phone_number_id: '109927651347890',
    };
    await seedClient(client);
    const customerPhone = '+12025550599';

    // Step 1 & 2: Outage simulation
    const originalQuery = pool.query;
    pool.query = vi.fn().mockRejectedValue(new Error('Database disconnect'));

    const metaScope1 = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('The team will get back to you shortly');
      })
      .reply(200, { ok: true });

    let payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'Book a room', 'msg_451');
    let response = await request(app).post('/webhook').send(payload);

    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope1.isDone()).toBe(true);

    // Step 3 & 4: Recovery
    pool.query = originalQuery;

    mockGeminiClient.models.generateContent
      .mockResolvedValueOnce({ text: 'booking' })
      .mockResolvedValueOnce({ text: 'What is your name?' });

    const metaScope2 = nock('https://graph.facebook.com')
      .post(`/v17.0/${client.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('What is your name?');
      })
      .reply(200, { ok: true });

    payload = makeMetaPayload(client.meta_phone_number_id, customerPhone, 'Book a room', 'msg_452');
    response = await request(app).post('/webhook').send(payload);

    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(metaScope2.isDone()).toBe(true);

    const conv = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [customerPhone]);
    expect(conv.rows[0].current_state).toBe('collecting_name');
  });
});
