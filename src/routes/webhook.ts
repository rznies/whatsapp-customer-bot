import { Router } from 'express';
import { pool as defaultPool } from '../db/connection.js';
import { classifyIntent as defaultClassifyIntent } from '../services/gemini.service.js';
import { bookingHandler as defaultBookingHandler } from '../handlers/booking.handler.js';
import { queryHandler as defaultQueryHandler } from '../handlers/query.handler.js';
import { sendMessage as defaultSendMessage } from '../services/whatsapp.service.js';
import { randomUUID } from 'crypto';
import { ClientConfig } from '../services/whatsapp.service.js';
import { parseWebhookBody } from '../utils/message-parser.js';

export interface WebhookDeps {
  classifyIntent(message: string): Promise<'query' | 'booking' | 'followup-cancel' | 'other'>;
  bookingHandler: {
    handle(message: string, conversation: any, clientConfig: ClientConfig, intent?: string): Promise<void>;
  };
  queryHandler: {
    handle(message: string, conversation: any, clientConfig: ClientConfig): Promise<void>;
  };
  sendMessage(to: string, text: string, config: ClientConfig): Promise<void>;
  pool: {
    query(text: string, params?: any[]): Promise<any>;
  };
}

export function createWebhookRouter(deps: WebhookDeps): Router {
  const { classifyIntent, bookingHandler, queryHandler, sendMessage, pool } = deps;
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
      let fromNumber: string | undefined;
      let toNumber: string | undefined;
      let metaPhoneId: string | undefined;
      let isTwilio = false;
      let client: any;

      try {
        // 1. Parse payload
        const parsed = parseWebhookBody(req.body);
        if (!parsed) {
          return;
        }

        fromNumber = parsed.fromNumber;
        toNumber = parsed.toNumber;
        metaPhoneId = parsed.metaPhoneId;
        isTwilio = parsed.isTwilio;
        const messageText = parsed.messageText;
        const messageId = parsed.messageId;

        // 2. Request deduplication
        if (messageId && isDuplicate(messageId)) {
          console.log(`Duplicate message ignored: ${messageId}`);
          return;
        }

        // 3. Resolve Client/Tenant
        if (isTwilio && toNumber) {
          // Search client by twilio number
          let cleanTo = toNumber.replace('whatsapp:', '').trim();
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
        } else if (metaPhoneId) {
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
        } else {
          return;
        }

        const customerPhone = fromNumber.startsWith('+') ? fromNumber : `+${fromNumber}`;

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
        const intent = await classifyIntent(messageText);

        if (intent === 'query') {
          await queryHandler.handle(messageText, conversation, client);
          await pool.query(
            'UPDATE conversations SET last_messaged_at = NOW() WHERE id = $1',
            [conversation.id]
          );
        } else {
          await bookingHandler.handle(messageText, conversation, client, intent);
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

  return router;
}

// Backward-compatible default instance
const defaultRouter = createWebhookRouter({
  classifyIntent: defaultClassifyIntent,
  bookingHandler: defaultBookingHandler,
  queryHandler: defaultQueryHandler,
  sendMessage: defaultSendMessage,
  pool: defaultPool,
});

export default defaultRouter;
