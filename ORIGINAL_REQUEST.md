# Original User Request

## Initial Request — 2026-06-06T12:11:33+05:30

Build a multi-tenant WhatsApp AI chatbot server for an agency, where one Node.js/TypeScript Express server serves multiple business clients, each with their own WhatsApp number, system prompt personality, and customer booking data.

Working directory: `e:/Mine/antigravity/business/whatsapp_customerBot`
Integrity mode: development

## Requirements

### R1. Multi-Tenant Database Schema (Neon Postgres)
Design and implement the database client and schema for Neon Postgres. Use `@neondatabase/serverless` or standard `pg` driver connecting via a `DATABASE_URL` env variable. The database needs four tables:
- `clients`: stores `id` (primary key), `name`, `meta_phone_number_id`, `whatsapp_token`, and `system_prompt` (defining how the AI speaks for that business).
- `conversations`: tracks customer state between messages. Stores `id` (primary key), `customer_phone_number`, `client_id` (foreign key to `clients`), `current_state` (enum/string: `idle`, `collecting_name`, `collecting_date`, `collecting_service`, `awaiting_confirmation`), `partial_booking_data` (JSON/JSONB for name, date, service), and `last_messaged_at` timestamp.
- `bookings`: stores confirmed appointments. Fields: `id` (primary key), `client_id` (foreign key to `clients`), `customer_name`, `service`, `date` (timestamp/date), and `status`.
- `follow_ups`: stores scheduled messages. Fields: `id` (primary key), `booking_id` (foreign key to `bookings`), `scheduled_time` (timestamp), and `sent` (boolean).

### R2. Core Services (Gemini & WhatsApp)
- **Gemini Service**: Interface with `gemini-3.1-flash-lite` to:
  1. Classify incoming message intent. The intent is strictly one of: `query`, `booking`, `followup-cancel`, or `other`.
  2. Generate responses using the specific client's `system_prompt` personality.
- **WhatsApp Service**: An abstraction containing a single `sendMessage` function. It checks the `USE_TWILIO` environment variable:
  - If `true`, use the Twilio SDK to send messages via Twilio Sandbox.
  - If `false` (or unset), make direct Meta Graph API HTTP calls.
  - The rest of the codebase must interact only with this abstraction, remaining agnostic of the underlying provider.

### R3. Webhook Endpoint and Handlers
- Single `POST` webhook endpoint that handles incoming WhatsApp messages from both Twilio (url-encoded form data) and Meta (JSON payload).
- Always return HTTP `200 OK` status immediately before processing details to prevent webhook retries.
- Parse customer phone number, message text, and client identifier.
- Route to appropriate handlers based on intent classification:
  - **Query Handler**: Fetches the client's system prompt from the database, generates a reply via Gemini, and sends it to the customer.
  - **Booking Handler**: A state machine managing states: `idle` -> `collecting name` -> `collecting date` -> `collecting service` -> `awaiting confirmation`. Persists state/data in `conversations` table. When confirmed, creates a booking, sends a confirmation message, and schedules a follow-up message for 24 hours later.
  - **Follow-up Cron**: A `node-cron` job running every 15 minutes. It checks the `follow_ups` table for unsent messages whose scheduled time has passed, sends them via the WhatsApp service, and marks them as sent.

### R4. Error Handling and Resilience
- Wrap webhook parsing and handlers in try-catch blocks.
- If any operation fails, catch the error, log it, and send a fallback WhatsApp message to the customer: "The team will get back to you shortly."
- The server must never crash on runtime errors.

### R5. Configuration and Documentation
- Create a `.env.example` file documenting all required environment variables with explanatory comments (e.g. `DATABASE_URL`, `GEMINI_API_KEY`, `USE_TWILIO`, Twilio credentials, Meta credentials).
- Write a detailed `README.md` explaining:
  - How to initialize the database tables.
  - How to set up and run the server locally.
  - How to test locally with the Twilio sandbox.
  - How to deploy the application to Railway.

### R6. Neon Setup via Neon MCP
- You can use the tools from the `mcp-server-neon` MCP server (like `run_sql`, `describe_table_schema`, etc.) to run migration SQL queries directly on the Postgres database and inspect tables/schemas as needed.

## Acceptance Criteria

### Project Structure & Compilation
- [ ] TypeScript config (`tsconfig.json`) and `package.json` are properly configured.
- [ ] Code compiles successfully without errors using a build command (e.g. `npm run build` or `tsc`).
- [ ] All packages (e.g., Express, pg, dotenv, node-cron, Gemini SDK, Twilio SDK) are installed and imported correctly.

### Server & Endpoint Validation
- [ ] The webhook parses Twilio's incoming payload format correctly.
- [ ] The webhook parses Meta's incoming payload format correctly.
- [ ] The webhook returns a `200` status code immediately upon receipt.
- [ ] Runtime errors are caught, returning a fallback response to the user and leaving the server running.
