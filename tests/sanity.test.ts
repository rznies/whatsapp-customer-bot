import { describe, test, expect } from 'vitest';
import { pool } from '../src/db/connection.js';
import { cleanDatabase, seedClient } from './helpers/db.js';
import { mockDatabase } from './setup.js';

describe('Database Sanity Test', () => {
  test('should insert and fetch client config successfully', async () => {
    await cleanDatabase();
    
    const client = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Bella Hair Salon',
      meta_phone_number_id: '109927651347890',
      whatsapp_token: 'EAAGxx887766aaBBccDDeeFF',
      system_prompt: 'Test prompt',
      use_twilio: false,
      whatsapp_number: '+14155238886',
    };
    
    await seedClient(client);
    
    const res = await pool.query('SELECT * FROM clients WHERE id = $1', [client.id]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].name).toBe('Bella Hair Salon');
    
    await cleanDatabase();
    const resAfterClean = await pool.query('SELECT * FROM clients');
    expect(resAfterClean.rows.length).toBe(0);
  });

  test('should verify required indexes exist in the schema', () => {
    const conversationsIndices = mockDatabase.getTable('conversations').listIndices();
    const conversationsIndexNames = conversationsIndices.map((idx: any) => idx.name);
    expect(conversationsIndexNames).toContain('idx_conversations_lookup');

    const followUpsIndices = mockDatabase.getTable('follow_ups').listIndices();
    const followUpsIndexNames = followUpsIndices.map((idx: any) => idx.name);
    expect(followUpsIndexNames).toContain('idx_follow_ups_cron');
  });
});
