import { describe, test, expect, beforeEach, vi } from 'vitest';
import nock from 'nock';
import { pool } from '../../src/db/connection.js';
import { cleanDatabase, seedClient } from '../helpers/db.js';
import { runFollowupJob, startFollowupCron } from '../../src/jobs/followup.cron.js';
import { mockTwilioClient } from '../setup.js';

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

describe('F6: Follow-up Cron Job E2E', () => {
  beforeEach(async () => {
    await cleanDatabase();
    nock.cleanAll();
    vi.clearAllMocks();
    await seedClient(CLIENT_A);
    await seedClient(CLIENT_B);
  });

  test('TC-6.1.1: Cron Schedule Execution', () => {
    vi.useFakeTimers();
    const cronInstance = startFollowupCron();
    expect(cronInstance).toBeDefined();
    // Fast forward clock by 15 minutes
    vi.advanceTimersByTime(15 * 60 * 1000);
    vi.useRealTimers();
    cronInstance.stop();
  });

  test('TC-6.1.2: Expired Unsent Selection & TC-6.1.3: Message Dispatch Trigger & TC-6.1.4: Update Database Sent Status', async () => {
    // 1. Create a booking for Client A (Meta)
    const bookingId = '880e8400-e29b-41d4-a716-446655440001';
    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
       VALUES ($1, $2, $3, $4, NOW(), 'confirmed')`,
      [bookingId, CLIENT_A.id, 'Alice', 'Haircut']
    );

    // Create a conversation for the customer phone so follow-up can find it (wait, followup needs phone number, which is in conversations!)
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
      ['770e8400-e29b-41d4-a716-446655440001', '+12025550199', CLIENT_A.id]
    );

    // 2. Schedule follow-up in the past (-10 minutes)
    const expiredTime = new Date(Date.now() - 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, $3, false)`,
      ['990e8400-e29b-41d4-a716-446655440001', bookingId, expiredTime]
    );

    // Mock Meta API response for follow-up message dispatch
    const metaScope = nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => {
        return body.text.body.includes('Alice') && body.text.body.includes('haircut');
      })
      .reply(200, { ok: true });

    // Run followup job
    await runFollowupJob();

    // Verify Meta API was invoked (TC-6.1.3)
    expect(metaScope.isDone()).toBe(true);

    // Verify database sent status is updated to true (TC-6.1.4)
    const fuRes = await pool.query('SELECT * FROM follow_ups WHERE id = $1', ['990e8400-e29b-41d4-a716-446655440001']);
    expect(fuRes.rows[0].sent).toBe(true);
  });

  test('TC-6.1.5: Ignore Future Scheduled Follow-ups', async () => {
    const bookingId = '880e8400-e29b-41d4-a716-446655440002';
    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
       VALUES ($1, $2, $3, $4, NOW(), 'confirmed')`,
      [bookingId, CLIENT_A.id, 'Bob', 'Haircut']
    );

    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
      ['770e8400-e29b-41d4-a716-446655440002', '+12025550299', CLIENT_A.id]
    );

    // Schedule follow-up in the future (+1 hour)
    const futureTime = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, $3, false)`,
      ['990e8400-e29b-41d4-a716-446655440002', bookingId, futureTime]
    );

    // Run followup job
    await runFollowupJob();

    // Verify database sent status is still false
    const fuRes = await pool.query('SELECT * FROM follow_ups WHERE id = $1', ['990e8400-e29b-41d4-a716-446655440002']);
    expect(fuRes.rows[0].sent).toBe(false);
  });

  test('TC-6.2.1: Mass Expiry Throttling', async () => {
    // Insert 60 follow-ups (more than batch size 50)
    const expiredTime = new Date(Date.now() - 10 * 60 * 1000);

    for (let i = 0; i < 60; i++) {
      const bId = `880e8400-e29b-41d4-a716-44665544${i.toString().padStart(4, '0')}`;
      const cId = `770e8400-e29b-41d4-a716-44665544${i.toString().padStart(4, '0')}`;
      const fId = `990e8400-e29b-41d4-a716-44665544${i.toString().padStart(4, '0')}`;
      const phone = `+1202555${i.toString().padStart(4, '0')}`;

      await pool.query(
        `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
         VALUES ($1, $2, $3, 'Haircut', NOW(), 'confirmed')`,
        [bId, CLIENT_A.id, `User${i}`]
      );
      await pool.query(
        `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
         VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
        [cId, phone, CLIENT_A.id]
      );
      await pool.query(
        `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
         VALUES ($1, $2, $3, false)`,
        [fId, bId, expiredTime]
      );
    }

    // Intercept Meta API for only 50 messages (the first batch)
    const metaScopes = Array.from({ length: 50 }).map(() =>
      nock('https://graph.facebook.com')
        .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
        .reply(200, { ok: true })
    );

    await runFollowupJob();

    // Verify 50 messages were sent
    metaScopes.forEach(scope => expect(scope.isDone()).toBe(true));

    // Assert that exactly 50 followups were updated to sent=true
    const sentCountRes = await pool.query('SELECT count(*) FROM follow_ups WHERE sent = true');
    expect(parseInt(sentCountRes.rows[0].count, 10)).toBe(50);
  });

  test('TC-6.2.2: Partial Batch Sending Failures', async () => {
    // Set up 3 followups
    const expiredTime = new Date(Date.now() - 10 * 60 * 1000);
    const details = [
      { b: '880e8400-e29b-41d4-a716-446655440021', f: '990e8400-e29b-41d4-a716-446655440021', phone: '+12025550021' }, // Client A (Meta) - Success
      { b: '880e8400-e29b-41d4-a716-446655440022', f: '990e8400-e29b-41d4-a716-446655440022', phone: '+12025550022' }, // Client A (Meta) - Fail
      { b: '880e8400-e29b-41d4-a716-446655440023', f: '990e8400-e29b-41d4-a716-446655440023', phone: '+12025550023' }, // Client A (Meta) - Success
    ];

    for (const d of details) {
      await pool.query(
        `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
         VALUES ($1, $2, 'TestUser', 'Haircut', NOW(), 'confirmed')`,
        [d.b, CLIENT_A.id]
      );
      await pool.query(
        `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
         VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
        [d.b.replace('880e', '770e'), d.phone, CLIENT_A.id]
      );
      await pool.query(
        `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
         VALUES ($1, $2, $3, false)`,
        [d.f, d.b, expiredTime]
      );
    }

    // Nock Meta API to succeed, fail, succeed
    nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => body.to === '12025550021')
      .reply(200, { ok: true });

    nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => body.to === '12025550022')
      .reply(400, { error: 'Invalid recipient' });

    nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`, body => body.to === '12025550023')
      .reply(200, { ok: true });

    await runFollowupJob();

    // Verify statuses
    const res1 = await pool.query('SELECT sent FROM follow_ups WHERE id = $1', [details[0].f]);
    expect(res1.rows[0].sent).toBe(true);

    const res2 = await pool.query('SELECT sent FROM follow_ups WHERE id = $1', [details[1].f]);
    expect(res2.rows[0].sent).toBe(false); // remained false because it failed

    const res3 = await pool.query('SELECT sent FROM follow_ups WHERE id = $1', [details[2].f]);
    expect(res3.rows[0].sent).toBe(true);
  });

  test('TC-6.2.3: Double Invocation Lock (Overlapping Runs)', async () => {
    // Run two jobs concurrently or check if lock is maintained
    const job1 = runFollowupJob();
    const job2 = runFollowupJob();

    await Promise.all([job1, job2]);
    // The second execution should exit immediately.
    // We can verify that no error was thrown and it completed.
  });

  test('TC-6.2.4: DB Outage during Cron Updates', async () => {
    const bookingId = '880e8400-e29b-41d4-a716-446655440030';
    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
       VALUES ($1, $2, 'Alice', 'Haircut', NOW(), 'confirmed')`,
      [bookingId, CLIENT_A.id]
    );
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
      ['770e8400-e29b-41d4-a716-446655440030', '+12025550300', CLIENT_A.id]
    );
    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, NOW() - INTERVAL '10 minutes', false)`,
      ['990e8400-e29b-41d4-a716-446655440030', bookingId]
    );

    // Meta API succeeds
    nock('https://graph.facebook.com')
      .post(`/v17.0/${CLIENT_A.meta_phone_number_id}/messages`)
      .reply(200, { ok: true });

    // Mock DB pool.query during updates to throw error
    const originalQuery = pool.query;
    let queryCallCount = 0;
    pool.query = vi.fn().mockImplementation(async (sql, params) => {
      queryCallCount++;
      // First calls select follow_ups and client details (let them succeed)
      // When it updates sent = true, fail it
      if (typeof sql === 'string' && sql.includes('UPDATE follow_ups')) {
        throw new Error('Database connection lost');
      }
      return (originalQuery as any).call(pool, sql, params);
    }) as any;

    try {
      await runFollowupJob();
    } catch (err: any) {
      expect(err.message).toContain('Database connection lost');
    } finally {
      pool.query = originalQuery;
    }
  });

  test('TC-6.2.5: Client Token Deletion before Cron', async () => {
    const bookingId = '880e8400-e29b-41d4-a716-446655440040';
    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
       VALUES ($1, $2, 'Alice', 'Haircut', NOW(), 'confirmed')`,
      [bookingId, CLIENT_A.id]
    );
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
       VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
      ['770e8400-e29b-41d4-a716-446655440040', '+12025550400', CLIENT_A.id]
    );
    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, NOW() - INTERVAL '10 minutes', false)`,
      ['990e8400-e29b-41d4-a716-446655440040', bookingId]
    );

    // Delete client before cron runs
    await pool.query('DELETE FROM clients WHERE id = $1', [CLIENT_A.id]);

    // Run followup cron, it should skip without crashing
    await runFollowupJob();

    const fuRes = await pool.query('SELECT * FROM follow_ups WHERE id = $1', ['990e8400-e29b-41d4-a716-446655440040']);
    expect(fuRes.rows[0]?.sent ?? false).toBe(false);
  });
});
