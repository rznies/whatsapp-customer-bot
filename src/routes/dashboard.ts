import { Router, Request, Response, NextFunction } from 'express';
import { dashboardService } from '../services/dashboard.service.js';

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
    const stats = await dashboardService.getOverviewStats();
    res.json(stats);
  } catch (error) {
    console.error('Error in GET /dashboard/overview:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/clients — returns list of all clients with their stats
router.get('/clients', async (req: Request, res: Response) => {
  try {
    const clients = await dashboardService.getClientsWithStats();
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
    const bookings = await dashboardService.getClientBookings(clientId, date as string);
    res.json(bookings);
  } catch (error) {
    console.error('Error in GET /dashboard/clients/:clientId/bookings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/clients/:clientId/conversations — returns recent conversations
router.get('/clients/:clientId/conversations', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  try {
    const conversations = await dashboardService.getClientConversations(clientId);
    res.json(conversations);
  } catch (error) {
    console.error('Error in GET /dashboard/clients/:clientId/conversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/clients/:clientId/followups — returns pending follow-ups
router.get('/clients/:clientId/followups', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  try {
    const followups = await dashboardService.getClientFollowups(clientId);
    res.json(followups);
  } catch (error) {
    console.error('Error in GET /dashboard/clients/:clientId/followups:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/clients/:clientId/stats — returns the four stat numbers
router.get('/clients/:clientId/stats', async (req: Request, res: Response) => {
  const { clientId } = req.params;
  try {
    const stats = await dashboardService.getClientStats(clientId);
    res.json(stats);
  } catch (error) {
    console.error('Error in GET /dashboard/clients/:clientId/stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /dashboard/conversations/:conversationId/takeover — sets paused to true
router.patch('/conversations/:conversationId/takeover', async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  try {
    const conversation = await dashboardService.takeoverConversation(conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ success: true, conversation });
  } catch (error) {
    console.error('Error in PATCH /dashboard/conversations/:conversationId/takeover:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /dashboard/conversations/:conversationId/resume — sets paused to false
router.patch('/conversations/:conversationId/resume', async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  try {
    const conversation = await dashboardService.resumeConversation(conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ success: true, conversation });
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
    const booking = await dashboardService.updateBookingStatus(bookingId, status);
    if (!booking) {
      res.status(404).json({ error: 'Booking not found' });
      return;
    }
    res.json({ success: true, booking });
  } catch (error) {
    console.error('Error in PATCH /bookings/:bookingId/status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /dashboard/followups/:followupId — deletes a pending follow-up
router.delete('/followups/:followupId', async (req: Request, res: Response) => {
  const { followupId } = req.params;
  try {
    const deletedFollowup = await dashboardService.deleteFollowup(followupId);
    if (!deletedFollowup) {
      res.status(404).json({ error: 'Followup not found' });
      return;
    }
    res.json({ success: true, deletedFollowup });
  } catch (error) {
    console.error('Error in DELETE /dashboard/followups/:followupId:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
