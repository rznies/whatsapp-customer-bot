import { randomUUID } from 'crypto';
import { pool } from '../db/connection.js';
import { ClientConfig, sendMessage } from '../services/whatsapp.service.js';
import { generateResponse } from '../services/gemini.service.js';
import {
  BookingState,
  PartialBooking,
  StateDecision,
  getNextState,
  extractName,
  isCancellation,
  isConfirmation,
  isInvalidDateReply,
  isInvalidServiceReply,
  parseBookingDate,
} from './booking-state-machine.js';

// --- Dependency interfaces ---

export interface BookingDeps {
  generateResponse(systemPrompt: string, history: string[], message: string): Promise<string>;
  sendMessage(to: string, text: string, config: ClientConfig): Promise<void>;
  pool: {
    query(text: string, params?: any[]): Promise<any>;
  };
}

// --- Module interface ---

export interface BookingModule {
  /** High-level entry point — the webhook calls this. */
  handleMessage(
    message: string,
    conversation: any,
    clientConfig: ClientConfig,
    intent?: string
  ): Promise<void>;

  /** Exposed for testing — pure state transition logic. */
  stateMachine: {
    getNextState: typeof getNextState;
    extractName: (text: string) => string;
    parseBookingDate: (dateStr: string) => Date;
    isConfirmation: (message: string) => boolean;
    isCancellation: (message: string) => boolean;
    isInvalidDateReply: (reply: string) => boolean;
    isInvalidServiceReply: (reply: string) => boolean;
  };
}

// --- Factory ---

export function createBookingModule(deps: BookingDeps): BookingModule {
  const { generateResponse: genResponse, sendMessage: send, pool: db } = deps;

  // Re-export pure state machine functions for testing access
  const stateMachine: BookingModule['stateMachine'] = {
    getNextState,
    extractName,
    parseBookingDate,
    isConfirmation,
    isCancellation,
    isInvalidDateReply,
    isInvalidServiceReply,
  };

  async function handleMessage(
    message: string,
    conversation: any,
    clientConfig: ClientConfig,
    intent?: string
  ): Promise<void> {
    const state: BookingState = conversation.current_state || 'idle';
    let partialData: PartialBooking = conversation.partial_booking_data || {};
    if (typeof partialData === 'string') {
      partialData = JSON.parse(partialData);
    }

    const customerPhone: string = conversation.customer_phone_number;
    const systemPrompt = clientConfig.system_prompt || '';

    // --- Idle-cancel: cancel an existing confirmed booking (consolidated from webhook.ts) ---
    if (
      state === 'idle' &&
      (intent === 'followup-cancel' || isCancellation(message))
    ) {
      const latestBookingRes = await db.query(
        "SELECT * FROM bookings WHERE client_id = $1 AND status = 'confirmed' ORDER BY date DESC LIMIT 1",
        [clientConfig.id]
      );
      if (latestBookingRes.rows.length > 0) {
        const bookingId = latestBookingRes.rows[0].id;
        await db.query(
          "UPDATE bookings SET status = 'cancelled' WHERE id = $1",
          [bookingId]
        );
        await db.query(
          "UPDATE follow_ups SET sent = true WHERE booking_id = $1",
          [bookingId]
        );
      }

      await db.query(
        'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
        ['idle', null, conversation.id]
      );

      await send(customerPhone, 'Your appointment has been cancelled.', clientConfig);
      return;
    }

    // --- Mid-flow cancellation ---
    if (state !== 'idle' && isCancellation(message)) {
      await db.query(
        'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
        ['idle', null, conversation.id]
      );
      const reply = await genResponse(systemPrompt, [], 'Booking cancelled.');
      await send(
        customerPhone,
        reply.toLowerCase().includes('cancel') ? reply : 'Booking cancelled.',
        clientConfig
      );
      return;
    }

    // --- Gemini-dependent validation for collecting_date and collecting_service ---
    // These states need the Gemini reply BEFORE deciding whether to advance or retry.
    if (state === 'collecting_date' || state === 'collecting_service') {
      const reply = await genResponse(systemPrompt, [], message);

      const shouldRetry =
        (state === 'collecting_date' && isInvalidDateReply(reply)) ||
        (state === 'collecting_service' && isInvalidServiceReply(reply));

      if (shouldRetry) {
        // Stay in current state — don't advance
        await send(customerPhone, reply, clientConfig);
        return;
      }

      // Gemini accepted the input — proceed with pure state machine transition
      const decision = getNextState(state, message, partialData);
      await db.query(
        'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
        [decision.nextState, JSON.stringify(decision.updatedData), conversation.id]
      );
      await send(customerPhone, reply, clientConfig);
      return;
    }

    // --- All other states: pure state machine transition ---
    const decision = getNextState(state, message, partialData);

    switch (decision.action) {
      case 'advance': {
        await db.query(
          'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
          [decision.nextState, JSON.stringify(decision.updatedData), conversation.id]
        );
        const reply = await genResponse(systemPrompt, [], message);
        await send(customerPhone, reply, clientConfig);
        break;
      }

      case 'confirm': {
        const bookingId = randomUUID();
        const parsedDate = parseBookingDate(decision.updatedData.date || '');

        // Save booking
        await db.query(
          `INSERT INTO bookings (id, client_id, customer_name, service, date, status, conversation_id)
           VALUES ($1, $2, $3, $4, $5, 'confirmed', $6)`,
          [bookingId, clientConfig.id, decision.updatedData.name, decision.updatedData.service, parsedDate, conversation.id]
        );

        // Schedule follow-up (24 hours later)
        const followupId = randomUUID();
        const scheduledTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await db.query(
          `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
           VALUES ($1, $2, $3, false)`,
          [followupId, bookingId, scheduledTime]
        );

        // Reset conversation
        await db.query(
          'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
          ['idle', null, conversation.id]
        );

        const reply = await genResponse(systemPrompt, [], message);
        await send(customerPhone, reply, clientConfig);
        break;
      }

      case 'cancel': {
        await db.query(
          'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
          ['idle', null, conversation.id]
        );
        const reply = await genResponse(systemPrompt, [], 'Booking cancelled by customer.');
        await send(
          customerPhone,
          reply.toLowerCase().includes('cancel') ? reply : 'Booking cancelled.',
          clientConfig
        );
        break;
      }

      case 'retry': {
        // Shouldn't reach here for non-date/service states, but handle gracefully
        const reply = await genResponse(systemPrompt, [], message);
        await send(customerPhone, reply, clientConfig);
        break;
      }
    }
  }

  return { handleMessage, stateMachine };
}

// --- Backward-compatible default instance ---

const defaultModule = createBookingModule({
  generateResponse,
  sendMessage,
  pool,
});

export const bookingHandler = {
  handle: defaultModule.handleMessage,
};

export { defaultModule as bookingModule };
