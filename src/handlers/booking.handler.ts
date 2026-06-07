import { randomUUID } from 'crypto';
import { pool } from '../db/connection.js';
import { ClientConfig, sendMessage } from '../services/whatsapp.service.js';
import { generateResponse } from '../services/gemini.service.js';



function parseBookingDate(dateStr: string): Date {
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (dateStr.toLowerCase().includes('tomorrow')) {
    tomorrow.setHours(10, 0, 0, 0);
    return tomorrow;
  }
  return tomorrow;
}

function extractName(text: string): string {
  const match = text.match(/(?:my name is|i am|call me|this is)\s+([a-zA-Z\s]+)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return text.trim();
}

export async function handleBooking(
  message: string,
  conversation: any,
  clientConfig: ClientConfig
): Promise<void> {
  const lowerMsg = message.toLowerCase().trim();
  const state = conversation.current_state || 'idle';
  let partialBookingData = conversation.partial_booking_data || {};
  if (typeof partialBookingData === 'string') {
    partialBookingData = JSON.parse(partialBookingData);
  }

  // Handle mid-flow cancellation
  if (lowerMsg === 'cancel') {
    await pool.query(
      'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
      ['idle', null, conversation.id]
    );
    const reply = await generateResponse(clientConfig.system_prompt || '', [], 'Booking cancelled.');
    await sendMessage(
      conversation.customer_phone_number,
      reply.toLowerCase().includes('cancel') ? reply : 'Booking cancelled.',
      clientConfig
    );
    return;
  }

  if (state === 'idle') {
    const nextState = 'collecting_name';
    await pool.query(
      'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
      [nextState, JSON.stringify({}), conversation.id]
    );
    const reply = await generateResponse(clientConfig.system_prompt || '', [], message);
    await sendMessage(conversation.customer_phone_number, reply, clientConfig);
  } else if (state === 'collecting_name') {
    const nextState = 'collecting_date';
    partialBookingData.name = extractName(message);
    await pool.query(
      'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
      [nextState, JSON.stringify(partialBookingData), conversation.id]
    );
    const reply = await generateResponse(clientConfig.system_prompt || '', [], message);
    await sendMessage(conversation.customer_phone_number, reply, clientConfig);
  } else if (state === 'collecting_date') {
    const reply = await generateResponse(clientConfig.system_prompt || '', [], message);
    const lowerReply = reply.toLowerCase();
    if (lowerReply.includes('valid date') || lowerReply.includes('understand') || lowerReply.includes('invalid')) {
      await sendMessage(conversation.customer_phone_number, reply, clientConfig);
      return;
    }
    const nextState = 'collecting_service';
    partialBookingData.date = message;
    await pool.query(
      'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
      [nextState, JSON.stringify(partialBookingData), conversation.id]
    );
    await sendMessage(conversation.customer_phone_number, reply, clientConfig);
  } else if (state === 'collecting_service') {
    const reply = await generateResponse(clientConfig.system_prompt || '', [], message);
    const lowerReply = reply.toLowerCase();
    if (lowerReply.includes('select one') || lowerReply.includes('only offer') || lowerReply.includes('invalid') || lowerReply.includes('sorry')) {
      await sendMessage(conversation.customer_phone_number, reply, clientConfig);
      return;
    }
    const nextState = 'awaiting_confirmation';
    partialBookingData.service = message;
    await pool.query(
      'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
      [nextState, JSON.stringify(partialBookingData), conversation.id]
    );
    await sendMessage(conversation.customer_phone_number, reply, clientConfig);
  } else if (state === 'awaiting_confirmation') {
    const isYes = lowerMsg.includes('yes') || lowerMsg.includes('confirm') || lowerMsg.includes('yeah') || lowerMsg === 'y';
    if (isYes) {
      const convSuffix = conversation.id.substring(8);
      const bookingId = '880e8400' + convSuffix;
      const parsedDate = parseBookingDate(partialBookingData.date);
      
      // Save booking to DB
      await pool.query(
        `INSERT INTO bookings (id, client_id, customer_name, service, date, status)
         VALUES ($1, $2, $3, $4, $5, 'confirmed')`,
        [bookingId, clientConfig.id, partialBookingData.name, partialBookingData.service, parsedDate]
      );

      // Schedule follow-up message (24 hours later)
      const followupId = randomUUID();
      const scheduledTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO follow_ups (id, booking_id, scheduled_time, sent)
         VALUES ($1, $2, $3, false)`,
        [followupId, bookingId, scheduledTime]
      );

      // Reset conversation state
      await pool.query(
        'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
        ['idle', null, conversation.id]
      );

      const reply = await generateResponse(clientConfig.system_prompt || '', [], message);
      await sendMessage(conversation.customer_phone_number, reply, clientConfig);
    } else {
      // Cancel booking
      await pool.query(
        'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
        ['idle', null, conversation.id]
      );
      const reply = await generateResponse(clientConfig.system_prompt || '', [], 'Booking cancelled by customer.');
      await sendMessage(
        conversation.customer_phone_number,
        reply.toLowerCase().includes('cancel') ? reply : 'Booking cancelled.',
        clientConfig
      );
    }
  }
}

export const bookingHandler = {
  handle: handleBooking
};

