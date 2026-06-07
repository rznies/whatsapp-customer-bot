import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { pool } from '../../src/db/connection.js';
import { cleanDatabase, seedClient } from '../helpers/db.js';
import { mockGeminiClient } from '../setup.js';

const CLIENT = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Salon Deluxe',
  meta_phone_number_id: '109927651347890',
  whatsapp_token: 'EAAGxx887766aaBBccDDeeFF',
  system_prompt: 'You are an AI assistant for Salon Deluxe.',
  use_twilio: false,
  whatsapp_number: '+14155238886',
};

const PASSWORD = 'dashboard-test-password-123';

describe('F8: Dashboard API & Takeover E2E', () => {
  beforeEach(async () => {
    process.env.DASHBOARD_PASSWORD = PASSWORD;
    await cleanDatabase();
    vi.clearAllMocks();
  });

  test('TC-8.1.1: Password authorization enforcement', async () => {
    await seedClient(CLIENT);

    // No password header -> 401
    const resNoAuth = await request(app).get('/dashboard/api/overview');
    expect(resNoAuth.status).toBe(401);
    expect(resNoAuth.body.error).toContain('Unauthorized');

    // Wrong password header -> 401
    const resWrongAuth = await request(app)
      .get('/dashboard/api/overview')
      .set('x-dashboard-password', 'wrong-pass');
    expect(resWrongAuth.status).toBe(401);

    // Correct password header -> 200
    const resAuth = await request(app)
      .get('/dashboard/api/overview')
      .set('x-dashboard-password', PASSWORD);
    expect(resAuth.status).toBe(200);
  });

  test('TC-8.1.2: Agency Overview statistics & client list', async () => {
    await seedClient(CLIENT);

    // Insert conversation
    const convId = '550e8400-e29b-41d4-a716-446655440022';
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
      [convId, '+12025550199', CLIENT.id]
    );

    // Insert booking
    const bookingId = '880e8400-e29b-41d4-a716-446655440022';
    const bookingDate = new Date(); // today
    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status, conversation_id)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', $6)`,
      [bookingId, CLIENT.id, 'Alice', 'Haircut', bookingDate, convId]
    );

    // Insert pending followup
    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, $3, false)`,
      ['550e8400-e29b-41d4-a716-446655449999', bookingId, new Date(Date.now() + 24 * 60 * 60 * 1000)]
    );

    // Get overview
    const resOverview = await request(app)
      .get('/dashboard/api/overview')
      .set('x-dashboard-password', PASSWORD);
    expect(resOverview.status).toBe(200);
    expect(resOverview.body.totalClients).toBe(1);
    expect(resOverview.body.totalBookingsThisWeek).toBe(1);
    expect(resOverview.body.totalConversationsHappening).toBe(1);
    expect(resOverview.body.totalFollowupsPending).toBe(1);

    // Get client list
    const resClients = await request(app)
      .get('/dashboard/api/clients')
      .set('x-dashboard-password', PASSWORD);
    expect(resClients.status).toBe(200);
    expect(resClients.body.length).toBe(1);
    expect(resClients.body[0].name).toBe('Salon Deluxe');
    expect(resClients.body[0].bookings_this_month).toBe(1);
    expect(resClients.body[0].active_conversations).toBe(1);
  });

  test('TC-8.1.3: Client specific dashboard details', async () => {
    await seedClient(CLIENT);

    const convId = '550e8400-e29b-41d4-a716-446655440022';
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
      [convId, '+12025550199', CLIENT.id]
    );

    const bookingId = '880e8400-e29b-41d4-a716-446655440022';
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const bookingDate = new Date(`${yyyy}-${mm}-${dd}T12:00:00.000Z`);

    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status, conversation_id)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', $6)`,
      [bookingId, CLIENT.id, 'Alice', 'Haircut', bookingDate, convId]
    );

    const followupId = '550e8400-e29b-41d4-a716-446655449999';
    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, $3, false)`,
      [followupId, bookingId, new Date(Date.now() + 24 * 60 * 60 * 1000)]
    );

    // 1. Get stats
    const resStats = await request(app)
      .get(`/dashboard/api/clients/${CLIENT.id}/stats`)
      .set('x-dashboard-password', PASSWORD);
    expect(resStats.status).toBe(200);
    expect(resStats.body.bookings_this_month).toBe(1);
    expect(resStats.body.bookings_this_week).toBe(1);
    expect(resStats.body.conversations_today).toBe(1);
    expect(resStats.body.followups_sent_this_month).toBe(0);

    // 2. Get bookings (filter today default)
    const resBookings = await request(app)
      .get(`/dashboard/api/clients/${CLIENT.id}/bookings`)
      .set('x-dashboard-password', PASSWORD);
    expect(resBookings.status).toBe(200);
    expect(resBookings.body.length).toBe(1);
    expect(resBookings.body[0].customer_name).toBe('Alice');

    // 3. Get recent conversations
    const resConvs = await request(app)
      .get(`/dashboard/api/clients/${CLIENT.id}/conversations`)
      .set('x-dashboard-password', PASSWORD);
    expect(resConvs.status).toBe(200);
    expect(resConvs.body.length).toBe(1);
    expect(resConvs.body[0].customer_phone_number).toBe('+12025550199');

    // 4. Get pending followups (mapped with phone)
    const resFollowups = await request(app)
      .get(`/dashboard/api/clients/${CLIENT.id}/followups`)
      .set('x-dashboard-password', PASSWORD);
    expect(resFollowups.status).toBe(200);
    expect(resFollowups.body.length).toBe(1);
    expect(resFollowups.body[0].customer_phone).toBe('+12025550199');
    expect(resFollowups.body[0].message_preview).toContain('Alice');
  });

  test('TC-8.1.4: Update booking status, takeover conversation, delete follow-up', async () => {
    await seedClient(CLIENT);

    const convId = '550e8400-e29b-41d4-a716-446655440022';
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
      [convId, '+12025550199', CLIENT.id]
    );

    const bookingId = '880e8400-e29b-41d4-a716-446655440022';
    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status, conversation_id)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', $6)`,
      [bookingId, CLIENT.id, 'Alice', 'Haircut', new Date(), convId]
    );

    const followupId = '550e8400-e29b-41d4-a716-446655449999';
    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, $3, false)`,
      [followupId, bookingId, new Date(Date.now() + 24 * 60 * 60 * 1000)]
    );

    // 1. Mark booking as cancelled
    const resCancelBooking = await request(app)
      .patch(`/dashboard/api/bookings/${bookingId}/status`)
      .set('x-dashboard-password', PASSWORD)
      .send({ status: 'cancelled' });
    expect(resCancelBooking.status).toBe(200);
    expect(resCancelBooking.body.booking.status).toBe('cancelled');

    // 2. Pause conversation (takeover)
    const resPauseConv = await request(app)
      .patch(`/dashboard/api/conversations/${convId}/takeover`)
      .set('x-dashboard-password', PASSWORD);
    expect(resPauseConv.status).toBe(200);
    expect(resPauseConv.body.conversation.paused).toBe(true);

    // 3. Resume conversation
    const resResumeConv = await request(app)
      .patch(`/dashboard/api/conversations/${convId}/resume`)
      .set('x-dashboard-password', PASSWORD);
    expect(resResumeConv.status).toBe(200);
    expect(resResumeConv.body.conversation.paused).toBe(false);

    // 4. Delete pending follow-up
    const resDeleteFollowup = await request(app)
      .delete(`/dashboard/api/followups/${followupId}`)
      .set('x-dashboard-password', PASSWORD);
    expect(resDeleteFollowup.status).toBe(200);

    // Verify deleted
    const countRes = await pool.query('SELECT COUNT(*) FROM follow_ups');
    expect(parseInt(countRes.rows[0].count, 10)).toBe(0);
  });

  test('TC-8.1.5: Bot ignores messages silently when conversation is paused', async () => {
    await seedClient(CLIENT);

    const convId = '550e8400-e29b-41d4-a716-446655440022';
    // Create conversation that is paused
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at, paused)
       VALUES ($1, $2, $3, 'idle', '{}', NOW(), true)`,
      [convId, '+12025550199', CLIENT.id]
    );

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
                  phone_number_id: CLIENT.meta_phone_number_id,
                },
                messages: [
                  {
                    from: '12025550199',
                    id: 'wamid.HBgLMTIwMjU1NTAxOTkVAgASGBQzQTA3QzBDN0RFQzQ4QzVDNkU5QjNBAA==',
                    timestamp: '1675903962',
                    text: { body: 'I want to speak with an agent please.' },
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

    // Send message via webhook
    const response = await request(app)
      .post('/webhook')
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');

    await new Promise(resolve => setTimeout(resolve, 250));

    // Verify Gemini was NOT called for intent classification or generation (0 calls)
    expect(mockGeminiClient.models.generateContent).not.toHaveBeenCalled();

    // Verify state was not updated (last_messaged_at didn't update significantly or state is still idle)
    const convRes = await pool.query('SELECT * FROM conversations WHERE id = $1', [convId]);
    expect(convRes.rows[0].current_state).toBe('idle');
  });

  test('TC-8.1.6: Static assets and SPA routes are not blocked by password auth', async () => {
    // If the folder contains index.html, it should serve 200 OK.
    const resStatic = await request(app).get('/dashboard/');
    expect(resStatic.status).toBe(200);
    expect(resStatic.text).toContain('<!doctype html>');
    expect(resStatic.text).toContain('dashboard');

    // Any SPA route fallback should also return 200 OK and index.html
    const resSPA = await request(app).get('/dashboard/arbitrary-page');
    expect(resSPA.status).toBe(200);
    expect(resSPA.text).toContain('<!doctype html>');
  });
});
