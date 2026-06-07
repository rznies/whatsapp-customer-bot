import { describe, test, expect, beforeEach } from 'vitest';
import { pool } from '../../src/db/connection.js';
import { cleanDatabase, seedClient } from '../helpers/db.js';
import crypto from 'crypto';

describe('F1: DB Schema & Multi-Tenancy E2E Tests', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  test('TC-1.1.1: Client Creation & Storage Verification', async () => {
    const clientId = crypto.randomUUID();
    const client = {
      id: clientId,
      name: 'Bella Hair Salon',
      meta_phone_number_id: '109927651347890',
      whatsapp_token: 'EAAGxx887766aaBBccDDeeFF',
      system_prompt: 'You are Bella, a friendly receptionist at Bella Hair Salon...',
      use_twilio: false,
      whatsapp_number: '+14155238886',
    };
    await seedClient(client);

    const res = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].name).toBe('Bella Hair Salon');
    expect(res.rows[0].meta_phone_number_id).toBe('109927651347890');
    expect(res.rows[0].whatsapp_token).toBe('EAAGxx887766aaBBccDDeeFF');
    expect(res.rows[0].system_prompt).toBe('You are Bella, a friendly receptionist at Bella Hair Salon...');
    expect(res.rows[0].use_twilio).toBe(false);
    expect(res.rows[0].whatsapp_number).toBe('+14155238886');
  });

  test('TC-1.1.2: Conversation Initialization', async () => {
    const clientId = crypto.randomUUID();
    const client = {
      id: clientId,
      name: 'Bella Hair Salon',
      meta_phone_number_id: '109927651347890',
      whatsapp_token: 'EAAGxx887766aaBBccDDeeFF',
      system_prompt: 'Test prompt',
      use_twilio: false,
      whatsapp_number: '+14155238886',
    };
    await seedClient(client);

    const convId = crypto.randomUUID();
    const phone = '+12025550199';
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [convId, phone, clientId, 'idle', JSON.stringify({})]
    );

    const res = await pool.query('SELECT * FROM conversations WHERE customer_phone_number = $1', [phone]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].current_state).toBe('idle');
    expect(res.rows[0].partial_booking_data).toEqual({});
  });

  test('TC-1.1.3: Booking Storage Sync', async () => {
    const clientId = crypto.randomUUID();
    await seedClient({
      id: clientId,
      name: 'Bella Hair Salon',
    });

    const bookingId = crypto.randomUUID();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [bookingId, clientId, 'Alice', 'Oil Change', tomorrow.toISOString(), 'confirmed']
    );

    const res = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].customer_name).toBe('Alice');
    expect(res.rows[0].service).toBe('Oil Change');
    expect(new Date(res.rows[0].date).toISOString()).toBe(tomorrow.toISOString());
    expect(res.rows[0].status).toBe('confirmed');
  });

  test('TC-1.1.4: Follow-up Record Insertion', async () => {
    const clientId = crypto.randomUUID();
    await seedClient({
      id: clientId,
      name: 'Bella Hair Salon',
    });

    const bookingId = crypto.randomUUID();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [bookingId, clientId, 'Alice', 'Oil Change', tomorrow.toISOString(), 'confirmed']
    );

    const followupId = crypto.randomUUID();
    const scheduledTime = new Date();
    scheduledTime.setHours(scheduledTime.getHours() + 24);

    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, $3, $4)`,
      [followupId, bookingId, scheduledTime.toISOString(), false]
    );

    const res = await pool.query('SELECT * FROM follow_ups WHERE booking_id = $1', [bookingId]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].sent).toBe(false);
    expect(new Date(res.rows[0].scheduled_time).toISOString()).toBe(scheduledTime.toISOString());
  });

  test('TC-1.1.5: Multi-Tenant Data Isolation', async () => {
    const clientAId = crypto.randomUUID();
    const clientBId = crypto.randomUUID();

    await seedClient({ id: clientAId, name: 'Client A' });
    await seedClient({ id: clientBId, name: 'Client B' });

    const phone = '+12025550199';
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), phone, clientAId, 'idle', JSON.stringify({ name: 'Alice' })]
    );

    // Query for Client B - should find nothing
    const resB = await pool.query('SELECT * FROM conversations WHERE client_id = $1', [clientBId]);
    expect(resB.rows.length).toBe(0);

    // Query for Client A - should find conversation
    const resA = await pool.query('SELECT * FROM conversations WHERE client_id = $1', [clientAId]);
    expect(resA.rows.length).toBe(1);
    expect(resA.rows[0].customer_phone_number).toBe(phone);
  });

  test('TC-1.2.1: SQL Injection Protection in Inputs', async () => {
    const clientId = crypto.randomUUID();
    const evilPrompt = `'; DROP TABLE clients; --`;
    const client = {
      id: clientId,
      name: 'Evil Salon',
      system_prompt: evilPrompt,
    };
    await seedClient(client);

    const res = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].system_prompt).toBe(evilPrompt);

    // Verify table wasn't dropped
    const clientsCount = await pool.query('SELECT COUNT(*) FROM clients');
    expect(parseInt(clientsCount.rows[0].count)).toBeGreaterThan(0);
  });

  test('TC-1.2.2: Concurrency Lock on Conversational State', async () => {
    const clientId = crypto.randomUUID();
    await seedClient({ id: clientId, name: 'Client A' });

    const convId = crypto.randomUUID();
    const phone = '+12025550199';
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [convId, phone, clientId, 'idle', '{}']
    );

    // Run parallel updates to simulate concurrent transactions
    await Promise.all([
      pool.query('UPDATE conversations SET current_state = $1 WHERE id = $2', ['collecting_name', convId]),
      pool.query('UPDATE conversations SET current_state = $1 WHERE id = $2', ['collecting_date', convId]),
    ]);

    const res = await pool.query('SELECT * FROM conversations WHERE id = $1', [convId]);
    expect(['collecting_name', 'collecting_date']).toContain(res.rows[0].current_state);
  });

  test('TC-1.2.3: Massive JSON payload in partial_booking_data', async () => {
    const clientId = crypto.randomUUID();
    await seedClient({ id: clientId, name: 'Client A' });

    const convId = crypto.randomUUID();
    const phone = '+12025550199';
    
    // Create massive nested object of around 100 KB
    const baseStr = 'a'.repeat(1000);
    const nestedData: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      nestedData[`key_${i}`] = baseStr;
    }

    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [convId, phone, clientId, 'idle', JSON.stringify(nestedData)]
    );

    const res = await pool.query('SELECT * FROM conversations WHERE id = $1', [convId]);
    expect(res.rows[0].partial_booking_data).toEqual(nestedData);
  });

  test('TC-1.2.4: Cascading Client Deletion', async () => {
    const clientId = crypto.randomUUID();
    await seedClient({ id: clientId, name: 'Client A' });

    const convId = crypto.randomUUID();
    const bookingId = crypto.randomUUID();
    const followupId = crypto.randomUUID();

    // Create conversation
    await pool.query(
      `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [convId, '+12025550199', clientId, 'idle', '{}']
    );

    // Create booking
    await pool.query(
      `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [bookingId, clientId, 'Alice', 'Haircut', new Date().toISOString(), 'confirmed']
    );

    // Create follow-up
    await pool.query(
      `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
       VALUES ($1, $2, $3, $4)`,
      [followupId, bookingId, new Date().toISOString(), false]
    );

    // Assert rows exist
    const c1 = await pool.query('SELECT COUNT(*) FROM conversations WHERE client_id = $1', [clientId]);
    const b1 = await pool.query('SELECT COUNT(*) FROM bookings WHERE client_id = $1', [clientId]);
    const f1 = await pool.query('SELECT COUNT(*) FROM follow_ups WHERE id = $1', [followupId]);
    expect(parseInt(c1.rows[0].count)).toBe(1);
    expect(parseInt(b1.rows[0].count)).toBe(1);
    expect(parseInt(f1.rows[0].count)).toBe(1);

    // Delete client
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);

    // Assert cascading delete
    const c2 = await pool.query('SELECT COUNT(*) FROM conversations WHERE client_id = $1', [clientId]);
    const b2 = await pool.query('SELECT COUNT(*) FROM bookings WHERE client_id = $1', [clientId]);
    const f2 = await pool.query('SELECT COUNT(*) FROM follow_ups WHERE id = $1', [followupId]);
    expect(parseInt(c2.rows[0].count)).toBe(0);
    expect(parseInt(b2.rows[0].count)).toBe(0);
    expect(parseInt(f2.rows[0].count)).toBe(0);
  });

  test('TC-1.2.5: Constraint Rejection for Invalid State Enum', async () => {
    const clientId = crypto.randomUUID();
    await seedClient({ id: clientId, name: 'Client A' });

    const convId = crypto.randomUUID();
    const phone = '+12025550199';

    // Attempt insert with invalid state - should throw error
    await expect(
      pool.query(
        `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data)
         VALUES ($1, $2, $3, $4, $5)`,
        [convId, phone, clientId, 'not_a_valid_state', '{}']
      )
    ).rejects.toThrow();
  });
});
