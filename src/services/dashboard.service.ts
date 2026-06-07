import { pool } from '../db/connection.js';
import {
  getStartOfWeek,
  getStartOfMonth,
  getStartOfToday,
  getActiveLimit24h,
  getDayRange
} from '../utils/date-utils.js';

export interface DatabaseConnection {
  query(text: string, params?: any[]): Promise<any>;
}

export class DashboardService {
  private db: DatabaseConnection;

  constructor(db: DatabaseConnection = pool) {
    this.db = db;
  }

  async getOverviewStats(): Promise<{
    totalClients: number;
    totalBookingsThisWeek: number;
    totalConversationsHappening: number;
    totalFollowupsPending: number;
  }> {
    const startOfWeek = getStartOfWeek();
    const endOfWeek = new Date(startOfWeek.getTime());
    endOfWeek.setDate(startOfWeek.getDate() + 7);
    const activeLimit = getActiveLimit24h();

    const [clientsRes, bookingsRes, convsRes, followupsRes] = await Promise.all([
      this.db.query('SELECT COUNT(*) as count FROM clients'),
      this.db.query('SELECT COUNT(*) as count FROM bookings WHERE date >= $1 AND date < $2', [startOfWeek, endOfWeek]),
      this.db.query('SELECT COUNT(*) as count FROM conversations WHERE last_messaged_at >= $1', [activeLimit]),
      this.db.query('SELECT COUNT(*) as count FROM follow_ups WHERE sent = false')
    ]);

    return {
      totalClients: parseInt(clientsRes.rows[0].count || '0', 10),
      totalBookingsThisWeek: parseInt(bookingsRes.rows[0].count || '0', 10),
      totalConversationsHappening: parseInt(convsRes.rows[0].count || '0', 10),
      totalFollowupsPending: parseInt(followupsRes.rows[0].count || '0', 10)
    };
  }

  async getClientsWithStats(): Promise<any[]> {
    const startOfMonth = getStartOfMonth();
    const activeLimit = getActiveLimit24h();

    const res = await this.db.query(`
      SELECT 
        c.id, 
        c.name, 
        c.whatsapp_number,
        COALESCE(b.bookings_count, 0)::integer as bookings_this_month,
        COALESCE(conv.convs_count, 0)::integer as active_conversations
      FROM clients c
      LEFT JOIN (
        SELECT client_id, COUNT(*)::integer as bookings_count 
        FROM bookings 
        WHERE date >= $1 
        GROUP BY client_id
      ) b ON c.id = b.client_id
      LEFT JOIN (
        SELECT client_id, COUNT(*)::integer as convs_count 
        FROM conversations 
        WHERE last_messaged_at >= $2 
        GROUP BY client_id
      ) conv ON c.id = conv.client_id
      ORDER BY c.name ASC
    `, [startOfMonth, activeLimit]);

    return res.rows;
  }

  async getClientBookings(clientId: string, dateStr?: string): Promise<any[]> {
    const { start, end } = getDayRange(dateStr);
    const res = await this.db.query(
      'SELECT * FROM bookings WHERE client_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC',
      [clientId, start, end]
    );
    return res.rows;
  }

  async getClientConversations(clientId: string): Promise<any[]> {
    const res = await this.db.query(
      'SELECT * FROM conversations WHERE client_id = $1 ORDER BY last_messaged_at DESC LIMIT 50',
      [clientId]
    );
    return res.rows;
  }

  async getClientFollowups(clientId: string): Promise<any[]> {
    const res = await this.db.query(`
      SELECT f.id, f.booking_id, f.scheduled_time, b.customer_name, b.service, c.customer_phone_number
      FROM follow_ups f
      JOIN bookings b ON f.booking_id = b.id
      JOIN conversations c ON b.conversation_id = c.id
      WHERE b.client_id = $1 AND f.sent = false
      ORDER BY f.scheduled_time ASC
    `, [clientId]);

    return res.rows.map((f: any) => ({
      id: f.id,
      booking_id: f.booking_id,
      customer_phone: f.customer_phone_number || 'Unknown',
      message_preview: `Hi ${f.customer_name}, this is a follow-up regarding your ${f.service.toLowerCase()} appointment.`,
      scheduled_time: f.scheduled_time
    }));
  }

  async getClientStats(clientId: string): Promise<any> {
    const startOfMonth = getStartOfMonth();
    const startOfWeek = getStartOfWeek();
    const startOfToday = getStartOfToday();

    const [monthRes, weekRes, todayConvRes, sentFollowupsRes] = await Promise.all([
      this.db.query('SELECT COUNT(*) as count FROM bookings WHERE client_id = $1 AND date >= $2', [clientId, startOfMonth]),
      this.db.query('SELECT COUNT(*) as count FROM bookings WHERE client_id = $1 AND date >= $2', [clientId, startOfWeek]),
      this.db.query('SELECT COUNT(*) as count FROM conversations WHERE client_id = $1 AND last_messaged_at >= $2', [clientId, startOfToday]),
      this.db.query(`
        SELECT COUNT(*) as count 
        FROM follow_ups f 
        JOIN bookings b ON f.booking_id = b.id 
        WHERE b.client_id = $1 AND f.sent = true AND f.scheduled_time >= $2
      `, [clientId, startOfMonth])
    ]);

    return {
      bookings_this_month: parseInt(monthRes.rows[0].count || '0', 10),
      bookings_this_week: parseInt(weekRes.rows[0].count || '0', 10),
      conversations_today: parseInt(todayConvRes.rows[0].count || '0', 10),
      followups_sent_this_month: parseInt(sentFollowupsRes.rows[0].count || '0', 10)
    };
  }

  async takeoverConversation(conversationId: string): Promise<any> {
    const res = await this.db.query(
      'UPDATE conversations SET paused = true WHERE id = $1 RETURNING *',
      [conversationId]
    );
    return res.rows[0] || null;
  }

  async resumeConversation(conversationId: string): Promise<any> {
    const res = await this.db.query(
      'UPDATE conversations SET paused = false WHERE id = $1 RETURNING *',
      [conversationId]
    );
    return res.rows[0] || null;
  }

  async updateBookingStatus(bookingId: string, status: 'confirmed' | 'cancelled'): Promise<any> {
    const res = await this.db.query(
      'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *',
      [status, bookingId]
    );
    return res.rows[0] || null;
  }

  async deleteFollowup(followupId: string): Promise<any> {
    const res = await this.db.query(
      'DELETE FROM follow_ups WHERE id = $1 RETURNING *',
      [followupId]
    );
    return res.rows[0] || null;
  }
}

// Default singleton instance
export const dashboardService = new DashboardService();
