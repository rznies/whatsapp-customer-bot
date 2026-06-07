# Project: WhatsApp Customer Bot

## Architecture
This project is a multi-tenant WhatsApp AI chatbot server built using Node.js, Express, and TypeScript. It uses a Neon Postgres database for multi-tenancy and state management, and the Gemini API for natural language understanding and response generation.

```
+-------------------------------------------------------+
|                       Express                         |
|                 (Webhook POST Endpoint)               |
+---------------------------+---------------------------+
                            |
                            v
               +------------+------------+
               |  Request Payload Parser |
               |     (Twilio vs Meta)    |
               +------------+------------+
                            |
                            v
               +------------+------------+
               |    Intent Classifier    | (Gemini Service)
               +------------+------------+
                            |
                            v
          +-----------------+-----------------+
          |                                   |
          v                                   v
+---------+---------+               +---------+---------+
|   Query Handler   |               |  Booking Handler  | (State Machine)
+---------+---------+               +---------+---------+
          |                                   |
          +-----------------+-----------------+
                            |
                            v
               +------------+------------+
               |    WhatsApp Provider    | (Twilio vs Meta Graph API)
               +-------------------------+
```

## Code Layout
- `src/db/connection.ts`: Database pool configuration using `@neondatabase/serverless` or standard `pg`.
- `src/db/schema.sql`: SQL migration script for tables.
- `src/services/gemini.service.ts`: Gemini Service integrating `@google/genai` (uses `gemini-3.1-flash-lite-preview`).
- `src/services/whatsapp.service.ts`: Abstracted WhatsApp Service with `sendMessage` method.
- `src/handlers/booking.handler.ts`: Booking state machine and DB updates.
- `src/handlers/query.handler.ts`: Handles general query intents.
- `src/jobs/followup.cron.ts`: Node-cron script running every 15 minutes.
- `src/routes/webhook.ts`: Webhook POST endpoint.
- `src/app.ts`: App configuration and middleware.
- `src/server.ts`: Server entry point.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Database & Workspace Initialization | Initialize package.json, tsconfig.json, DB schema migration, connection utility | None | PLANNED |
| M2 | Core Services | Gemini Service and WhatsApp Service (Twilio/Meta) | M1 | PLANNED |
| M3 | Webhook Endpoint & Handler Routing | Webhook POST endpoint, request parsing, response generation, query routing | M2 | PLANNED |
| M4 | Booking State Machine & Follow-up Cron | Booking state machine, database persistence, follow-up cron | M3 | PLANNED |
| M5 | E2E Testing & Coverage Hardening | Run E2E tests, cover edge cases, adversarial hardening | M4 | PLANNED |

## Interface Contracts

### Gemini Service
- `classifyIntent(message: string): Promise<'query' | 'booking' | 'followup-cancel' | 'other'>`
- `generateResponse(systemPrompt: string, conversationHistory: string[], userMessage: string): Promise<string>`

### WhatsApp Service
- `sendMessage(to: string, text: string, clientConfig: ClientConfig): Promise<void>`
  - `ClientConfig` includes `meta_phone_number_id`, `whatsapp_token` etc.

### Database Schema
- `clients` table: `id` (UUID/PK), `name` (text), `meta_phone_number_id` (text), `whatsapp_token` (text), `system_prompt` (text).
- `conversations` table: `id` (UUID/PK), `customer_phone_number` (text), `client_id` (UUID/FK), `current_state` (text), `partial_booking_data` (JSONB), `last_messaged_at` (timestamp).
- `bookings` table: `id` (UUID/PK), `client_id` (UUID/FK), `customer_name` (text), `service` (text), `date` (timestamp), `status` (text).
- `follow_ups` table: `id` (UUID/PK), `booking_id` (UUID/FK), `scheduled_time` (timestamp), `sent` (boolean).
