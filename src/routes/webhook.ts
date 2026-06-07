import { Router } from 'express';
import { pool } from '../db/connection.js';
import { classifyIntent } from '../services/gemini.service.js';
import { bookingHandler } from '../handlers/booking.handler.js';
import { queryHandler } from '../handlers/query.handler.js';
import { sendMessage } from '../services/whatsapp.service.js';
import { randomUUID } from 'crypto';

const router = Router();
const processedMessages = new Set<string>();

function isDuplicate(messageId: string): boolean {
  if (processedMessages.has(messageId)) {
    return true;
  }
  processedMessages.add(messageId);
  if (processedMessages.size > 5000) {
    const firstKey = processedMessages.keys().next().value;
    if (firstKey) processedMessages.delete(firstKey);
  }
  return false;
}

// GET challenge verification for Meta Webhook setup
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && challenge) {
    res.status(200).send(challenge);
    return;
  }
  
  res.status(400).send('Invalid verification request');
});

// POST endpoint for receiving Twilio or Meta webhooks
router.post('/', async (req, res) => {
  // Return 200 OK immediately to satisfy webhook retry policies
  res.status(200).send('OK');

  // Perform processing asynchronously
  (async () => {
    let messageId: string | undefined;
    let fromNumber: string | undefined;
    let toNumber: string | undefined;
    let messageText: string | undefined;
    let metaPhoneId: string | undefined;
    let isTwilio = false;
    let client: any;

    try {
      if (!req.body || typeof req.body !== 'object') {
        return;
      }

      // 1. Distinguish between Twilio and Meta payload
      if (req.body.From && req.body.To) {
        // Twilio payload
        isTwilio = true;
        fromNumber = req.body.From.replace('whatsapp:', '').trim();
        toNumber = req.body.To.replace('whatsapp:', '').trim();
        messageText = req.body.Body;
        messageId = req.body.MessageSid;

        if (!fromNumber || !toNumber) {
          console.warn('Twilio payload missing From or To parameter');
          return;
        }
      } else if (req.body.object === 'whatsapp_business_account') {
        // Meta JSON payload
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        const metadata = value?.metadata;
        const message = value?.messages?.[0];

        if (!message) {
          // Empty payload, ignore gracefully
          return;
        }

        isTwilio = false;
        fromNumber = message.from; // format digits only, e.g. 12025550199
        if (fromNumber && !fromNumber.startsWith('+')) {
          fromNumber = '+' + fromNumber;
        }
        metaPhoneId = metadata?.phone_number_id;
        messageText = message.text?.body;
        messageId = message.id;

        if (!fromNumber || !metaPhoneId) {
          console.warn('Meta payload missing from or metadata.phone_number_id');
          return;
        }
      } else {
        // Unknown payload format
        console.warn('Unknown webhook payload received');
        return;
      }

      // 2. Request deduplication
      if (messageId && isDuplicate(messageId)) {
        console.log(`Duplicate message ignored: ${messageId}`);
        return;
      }

      // 3. Resolve Client/Tenant
      if (isTwilio) {
        // Search client by twilio number
        let cleanTo = toNumber!.replace('whatsapp:', '').trim();
        if (cleanTo && !cleanTo.startsWith('+')) {
          cleanTo = '+' + cleanTo;
        }
        const clientRes = await pool.query(
          'SELECT * FROM clients WHERE whatsapp_number = $1 OR whatsapp_number = $2',
          [toNumber, cleanTo]
        );
        if (clientRes.rows.length === 0) {
          console.warn(`Unregistered Twilio client: ${toNumber}`);
          return;
        }
        client = clientRes.rows[0];
      } else {
        // Search client by Meta phone number ID
        const clientRes = await pool.query(
          'SELECT * FROM clients WHERE meta_phone_number_id = $1',
          [metaPhoneId]
        );
        if (clientRes.rows.length === 0) {
          console.warn(`Unregistered Meta client ID: ${metaPhoneId}`);
          return;
        }
        client = clientRes.rows[0];
      }

      const customerPhone = fromNumber!.startsWith('+') ? fromNumber! : `+${fromNumber}`;

      // 4. Resolve or initialize conversation session
      let convRes = await pool.query(
        'SELECT * FROM conversations WHERE client_id = $1 AND customer_phone_number = $2',
        [client.id, customerPhone]
      );

      let conversation: any;
      if (convRes.rows.length > 0) {
        conversation = convRes.rows[0];
        
        // Session Expiry Check (24 hours)
        const lastMsgTime = new Date(conversation.last_messaged_at).getTime();
        if (Date.now() - lastMsgTime > 24 * 60 * 60 * 1000) {
          console.log(`Session expired for customer: ${customerPhone}. Resetting state.`);
          await pool.query(
            'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
            ['idle', null, conversation.id]
          );
          // Reload conversation
          const reloaded = await pool.query('SELECT * FROM conversations WHERE id = $1', [conversation.id]);
          conversation = reloaded.rows[0];
        }
      } else {
        // Initialize new conversation session
        const convId = randomUUID();
        await pool.query(
          `INSERT INTO conversations (id, customer_phone_number, client_id, current_state, partial_booking_data, last_messaged_at)
           VALUES ($1, $2, $3, 'idle', '{}', NOW())`,
          [convId, customerPhone, client.id]
        );
        const newConvRes = await pool.query('SELECT * FROM conversations WHERE id = $1', [convId]);
        conversation = newConvRes.rows[0];
      }

      if (conversation.paused) {
        console.log(`Conversation for customer ${customerPhone} is paused. Skipping auto-response.`);
        return;
      }

      // 5. Intent Classification
      const textToClassify = messageText || '';
      const intent = await classifyIntent(textToClassify);

      // 6. Handle Intent Switching / Cancel (only when idle, so we don't hijack booking cancellations)
      if (conversation.current_state === 'idle' && (intent === 'followup-cancel' || textToClassify.toLowerCase().trim() === 'cancel')) {
        const latestBookingRes = await pool.query(
          "SELECT * FROM bookings WHERE client_id = $1 AND status = 'confirmed' ORDER BY date DESC LIMIT 1",
          [client.id]
        );
        if (latestBookingRes.rows.length > 0) {
          const bookingId = latestBookingRes.rows[0].id;
          await pool.query(
            "UPDATE bookings SET status = 'cancelled' WHERE id = $1",
            [bookingId]
          );
          await pool.query(
            "UPDATE follow_ups SET sent = true WHERE booking_id = $1",
            [bookingId]
          );
        }

        await pool.query(
          'UPDATE conversations SET current_state = $1, partial_booking_data = $2, last_messaged_at = NOW() WHERE id = $3',
          ['idle', null, conversation.id]
        );

        await sendMessage(customerPhone, 'Your appointment has been cancelled.', client);
        return;
      }

      if (intent === 'query') {
        await queryHandler.handle(textToClassify, conversation, client);
        await pool.query(
          'UPDATE conversations SET last_messaged_at = NOW() WHERE id = $1',
          [conversation.id]
        );
      } else {
        await bookingHandler.handle(textToClassify, conversation, client);
      }

    } catch (error) {
      console.error('Error in webhook processing:', error);
      try {
        if (fromNumber) {
          const customerPhone = fromNumber.startsWith('+') ? fromNumber : `+${fromNumber}`;
          const fallbackClient = client || {
            meta_phone_number_id: metaPhoneId,
            whatsapp_token: process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_TOKEN || '',
            use_twilio: isTwilio,
            whatsapp_number: toNumber
          };
          await sendMessage(customerPhone, 'The team will get back to you shortly.', fallbackClient);
        }
      } catch (sendError) {
        console.error('Error sending fallback message:', sendError);
      }
    }
  })();
});

export default router;

