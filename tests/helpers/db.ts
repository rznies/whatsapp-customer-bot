import { pool } from '../../src/db/connection.js';
import { ClientConfig } from '../../src/services/whatsapp.service.js';

export async function cleanDatabase(): Promise<void> {
  // Delete in order of foreign key constraints to prevent cascade violations
  await pool.query('DELETE FROM follow_ups;');
  await pool.query('DELETE FROM bookings;');
  await pool.query('DELETE FROM conversations;');
  await pool.query('DELETE FROM clients;');
}

export async function seedClient(client: ClientConfig): Promise<void> {
  await pool.query(
    `INSERT INTO clients (id, name, meta_phone_number_id, whatsapp_token, system_prompt, use_twilio, whatsapp_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      client.id,
      client.name,
      client.meta_phone_number_id || null,
      client.whatsapp_token || null,
      client.system_prompt || null,
      client.use_twilio || false,
      client.whatsapp_number || null,
    ]
  );
}
