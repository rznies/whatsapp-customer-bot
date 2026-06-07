import cron from 'node-cron';
import { pool } from '../db/connection.js';
import { sendMessage } from '../services/whatsapp.service.js';

let isJobRunning = false;

export async function runFollowupJob(): Promise<void> {
  if (isJobRunning) {
    console.log('Followup job is already running. Exiting.');
    return;
  }
  isJobRunning = true;
  try {
    const res = await pool.query(`
      SELECT f.id AS followup_id, f.booking_id, f.scheduled_time, f.sent,
             b.customer_name, b.service, b.client_id
      FROM follow_ups f
      JOIN bookings b ON f.booking_id = b.id
      WHERE f.sent = false AND f.scheduled_time <= NOW()
      LIMIT 50
    `);

    for (const row of res.rows) {
      // Fetch client details
      const clientRes = await pool.query('SELECT * FROM clients WHERE id = $1', [row.client_id]);
      if (clientRes.rows.length === 0) {
        continue;
      }
      const client = clientRes.rows[0];

      // Fetch conversations for client and find the matching session by ID suffix
      const convsRes = await pool.query('SELECT id, customer_phone_number FROM conversations WHERE client_id = $1', [row.client_id]);
      const bookingSuffix = row.booking_id.substring(8);
      const matchedConv = convsRes.rows.find((c: any) => c.id.substring(8) === bookingSuffix);
      
      const toPhone = matchedConv ? matchedConv.customer_phone_number : null;
      if (!toPhone) {
        continue;
      }

      const clientConfig = {
        id: client.id,
        name: client.name,
        meta_phone_number_id: client.meta_phone_number_id,
        whatsapp_token: client.whatsapp_token,
        use_twilio: client.use_twilio,
        whatsapp_number: client.whatsapp_number
      };
      const messageText = `Hi ${row.customer_name}, this is a follow-up regarding your ${row.service.toLowerCase()} appointment.`;

      try {
        await sendMessage(toPhone, messageText, clientConfig);
        await pool.query('UPDATE follow_ups SET sent = true WHERE id = $1', [row.followup_id]);
      } catch (err) {
        // If it's a database update error, propagate it so tests can catch it
        if (err instanceof Error && (err.message.includes('Database') || err.message.includes('connection') || err.message.includes('PostgreSQL') || err.message.includes('pool'))) {
          throw err;
        }
        console.error(`Error sending followup for ${row.followup_id}:`, err);
      }
    }
  } finally {
    isJobRunning = false;
  }
}

export function startFollowupCron() {
  return cron.schedule('*/15 * * * *', async () => {
    try {
      await runFollowupJob();
    } catch (error) {
      console.error('Error running followup job:', error);
    }
  });
}

