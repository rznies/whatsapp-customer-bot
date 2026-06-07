import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/connection.js';

const router = Router();

// Middleware to check x-dashboard-password header
export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const password = req.headers['x-dashboard-password'];
  const expectedPassword = process.env.DASHBOARD_PASSWORD;
  
  if (!expectedPassword || password !== expectedPassword) {
    res.status(401).json({ error: 'Unauthorized: Invalid password' });
    return;
  }
  next();
};

router.use(authMiddleware);

// GET /dashboard/overview — returns agency-level stats
router.get('/overview', async (req: Request, res: Response) => {
  try {
    // 1. Total number of active clients
    const clientsCountRes = await pool.query('SELECT COUNT(*) as count FROM clients');
    const totalClients = parseInt(clientsCountRes.rows[0].count || '0', 10);

    // 2. Total bookings across all clients this week
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday start
    const startOfWeek = new Date(now.setDate(diff));
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);

    const bookingsCountRes = await pool.query(
      'SELECT COUNT(*) as count FROM bookings WHERE date >= $1 AND date < $2',
      [startOfWeek, endOfWeek]
    );
    const totalBookingsThisWeek = parseInt(bookingsCountRes.rows[0].count || '0', 10);

    // 3. Total conversations happening right now (updated in last 24 hours)
    const activeLimit = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const conversationsCountRes = await pool.query(
      'SELECT COUNT(*) as count FROM conversations WHERE last_messaged_at >= $1',
      [activeLimit]
    );
    const totalConversationsHappening = parseInt(conversationsCountRes.rows[0].count || '0', 10);

    // 4. Total follow-ups pending across all clients
    const followupsCountRes = await pool.query(
      'SELECT COUNT(*) as count FROM follow_ups WHERE sent = false'
    );
    const totalFollowupsPending = parseInt(followupsCountRes.rows[0].count || '0', 10);

    res.json({
      totalClients,
      totalBookingsThisWeek,
      totalConversationsHappening,
      totalFollowupsPending
    });
  } catch (error) {
    console.error('Error in GET /dashboard/overview:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/clients — returns list of all clients with their stats
router.get('/clients', async (req: Request, res: Response) => {
  try {
    // Calculate start of current month and active conversations threshold
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const activeLimit = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const clientsRes = await pool.query('SELECT id, name, whatsapp_number FROM clients ORDER BY name ASC');
    const clients = [];

    for (const row of clientsRes.rows) {
      const bookingsCountRes = await pool.query(
        'SELECT COUNT(*) as count FROM bookings WHERE client_id = $1 AND date >= $2',
        [row.id, startOfMonth]
      );
      const conversationsCountRes = await pool.query(
        'SELECT COUNT(*) as count FROM conversations WHERE client_id = $1 AND last_messaged_at >= $2',
        [row.id, activeLimit]
      );

      clients.push({
        id: row.id,
        name: row.name,
        whatsapp_number: row.whatsapp_number,
        bookings_this_month: parseInt(bookingsCountRes.rows[0].count || '0', 10),
        active_conversations: parseInt(conversationsCountRes.rows[0].count || '0', 10)
      });
    }

    res.json(clients);
  } catch (error) {
    console.error('Error in GET /dashboard/clients:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/clients/:clientId/bookings — returns bookings for that client, accept a date query param
router.get('/clients/:clientId/bookings', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  const { date } = req.query;
  try {
    let startOfDay: Date;
    let endOfDay: Date;

    if (date && typeof date === 'string') {
      startOfDay = new Date(`${date}T00:00:00.000Z`);
      endOfDay = new Date(`${date}T23:59:59.999Z`);
    } else {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      startOfDay = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
      endOfDay = new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`);
    }

    const bookingsRes = await pool.query(
      'SELECT * FROM bookings WHERE client_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC',
      [clientId, startOfDay, endOfDay]
    );

    res.json(bookingsRes.rows);
  } catch (error) {
    console.error('Error in GET /dashboard/clients/:clientId/bookings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/clients/:clientId/conversations — returns recent conversations
router.get('/clients/:clientId/conversations', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  try {
    const convsRes = await pool.query(
      'SELECT * FROM conversations WHERE client_id = $1 ORDER BY last_messaged_at DESC LIMIT 50',
      [clientId]
    );
    res.json(convsRes.rows);
  } catch (error) {
    console.error('Error in GET /dashboard/clients/:clientId/conversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/clients/:clientId/followups — returns pending follow-ups
router.get('/clients/:clientId/followups', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  try {
    const followupsRes = await pool.query(`
      SELECT f.id, f.booking_id, f.scheduled_time, b.customer_name, b.service
      FROM follow_ups f
      JOIN bookings b ON f.booking_id = b.id
      WHERE b.client_id = $1 AND f.sent = false
      ORDER BY f.scheduled_time ASC
    `, [clientId]);

    const conversationsRes = await pool.query(`
      SELECT id, customer_phone_number FROM conversations WHERE client_id = $1
    `, [clientId]);

    const mappedFollowups = followupsRes.rows.map((f: any) => {
      const bookingSuffix = f.booking_id.substring(8);
      const matchedConv = conversationsRes.rows.find((c: any) => c.id.substring(8) === bookingSuffix);
      return {
        id: f.id,
        booking_id: f.booking_id,
        customer_phone: matchedConv ? matchedConv.customer_phone_number : 'Unknown',
        message_preview: `Hi ${f.customer_name}, this is a follow-up regarding your ${f.service.toLowerCase()} appointment.`,
        scheduled_time: f.scheduled_time
      };
    });

    res.json(mappedFollowups);
  } catch (error) {
    console.error('Error in GET /dashboard/clients/:clientId/followups:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/clients/:clientId/stats — returns the four stat numbers
router.get('/clients/:clientId/stats', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const startOfWeek = new Date(now.setDate(diff));
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const bookingsMonthRes = await pool.query(
      'SELECT COUNT(*) as count FROM bookings WHERE client_id = $1 AND date >= $2',
      [clientId, startOfMonth]
    );
    const bookingsWeekRes = await pool.query(
      'SELECT COUNT(*) as count FROM bookings WHERE client_id = $1 AND date >= $2',
      [clientId, startOfWeek]
    );
    const conversationsTodayRes = await pool.query(
      'SELECT COUNT(*) as count FROM conversations WHERE client_id = $1 AND last_messaged_at >= $2',
      [clientId, startOfToday]
    );
    const followupsMonthRes = await pool.query(
      'SELECT COUNT(*) as count FROM follow_ups f JOIN bookings b ON f.booking_id = b.id WHERE b.client_id = $1 AND f.sent = true AND f.scheduled_time >= $2',
      [clientId, startOfMonth]
    );

    res.json({
      bookings_this_month: parseInt(bookingsMonthRes.rows[0].count || '0', 10),
      bookings_this_week: parseInt(bookingsWeekRes.rows[0].count || '0', 10),
      conversations_today: parseInt(conversationsTodayRes.rows[0].count || '0', 10),
      followups_sent_this_month: parseInt(followupsMonthRes.rows[0].count || '0', 10)
    });
  } catch (error) {
    console.error('Error in GET /dashboard/clients/:clientId/stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /dashboard/conversations/:conversationId/takeover — sets paused to true
router.patch('/conversations/:conversationId/takeover', async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  try {
    const updateRes = await pool.query(
      'UPDATE conversations SET paused = true WHERE id = $1 RETURNING *',
      [conversationId]
    );
    if (updateRes.rows.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ success: true, conversation: updateRes.rows[0] });
  } catch (error) {
    console.error('Error in PATCH /dashboard/conversations/:conversationId/takeover:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /dashboard/conversations/:conversationId/resume — sets paused to false
router.patch('/conversations/:conversationId/resume', async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  try {
    const updateRes = await pool.query(
      'UPDATE conversations SET paused = false WHERE id = $1 RETURNING *',
      [conversationId]
    );
    if (updateRes.rows.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ success: true, conversation: updateRes.rows[0] });
  } catch (error) {
    console.error('Error in PATCH /dashboard/conversations/:conversationId/resume:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /dashboard/bookings/:bookingId/status — updates booking status
router.patch('/bookings/:bookingId/status', async (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const { status } = req.body;
  try {
    if (!status || (status !== 'confirmed' && status !== 'cancelled')) {
      res.status(400).json({ error: 'Invalid or missing status' });
      return;
    }
    const updateRes = await pool.query(
      'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *',
      [status, bookingId]
    );
    if (updateRes.rows.length === 0) {
      res.status(404).json({ error: 'Booking not found' });
      return;
    }
    res.json({ success: true, booking: updateRes.rows[0] });
  } catch (error) {
    console.error('Error in PATCH /dashboard/bookings/:bookingId/status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /dashboard/followups/:followupId — deletes a pending follow-up
router.delete('/followups/:followupId', async (req: Request, res: Response) => {
  const { followupId } = req.params;
  try {
    const deleteRes = await pool.query(
      'DELETE FROM follow_ups WHERE id = $1 RETURNING *',
      [followupId]
    );
    if (deleteRes.rows.length === 0) {
      res.status(404).json({ error: 'Followup not found' });
      return;
    }
    res.json({ success: true, deletedFollowup: deleteRes.rows[0] });
  } catch (error) {
    console.error('Error in DELETE /dashboard/followups/:followupId:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
