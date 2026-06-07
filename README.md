# Multi-Tenant WhatsApp AI Chatbot Server

A multi-tenant WhatsApp AI chatbot server built with **Node.js**, **TypeScript**, **Express**, **Neon Postgres**, and **Google Gemini** (`gemini-3.1-flash-lite`).

This chatbot acts as a virtual customer service receptionist for multiple tenant businesses. It uses a state machine to guide customers through a booking flow, validates input dynamically using Gemini, registers confirmed bookings, and schedules follow-up messages using a cron job.

---

## Tech Stack & Architecture

- **Runtime & Language**: Node.js, TypeScript
- **Framework**: Express.js
- **AI Model**: Google Gemini (`gemini-3.1-flash-lite-preview` / `@google/genai`)
- **Database**: Neon Postgres
- **Task Scheduler**: `node-cron`
- **WhatsApp Integrations**:
  - Twilio Sandbox (for testing)
  - Meta Cloud API (production ready)
  - Abstraction layered to switch providers via `USE_TWILIO` env variable.

---

## Project Structure

```
├── src/
│   ├── app.ts                 # Express application setup
│   ├── server.ts              # Server entry point
│   ├── db/
│   │   ├── connection.ts      # Neon database client & connection pool
│   │   └── schema.sql         # SQL migrations schema
│   ├── handlers/
│   │   ├── booking.handler.ts # Booking state machine handler
│   │   └── query.handler.ts   # General user queries handler
│   ├── jobs/
│   │   └── followup.cron.ts   # Cron job to send 24h follow-ups
│   ├── routes/
│   │   └── webhook.ts         # Single WhatsApp webhook endpoint
│   └── services/
│       ├── gemini.service.ts  # Gemini AI client, intent, and response generation
│       └── whatsapp.service.ts# Abstracted Twilio & Meta message dispatch service
├── tests/                     # E2E and unit test suite
├── .env.example               # Template environment configuration
├── tsconfig.json              # TypeScript compilation configuration
└── package.json               # Dependencies and runner scripts
```

---

## Getting Started

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- A [Neon Console](https://neon.tech/) account (for Serverless Postgres)
- A [Google AI Studio](https://aistudio.google.com/) API Key (for Gemini)

### 2. Install Dependencies
Clone the repository and run:
```bash
npm install
```

### 3. Database Initialization
Deploy the database schema to your Neon database. You can do this by executing the SQL statements inside [schema.sql](file:///e:/Mine/antigravity/business/whatsapp_customerBot/src/db/schema.sql) directly in your Neon console's SQL Editor:

```sql
CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    meta_phone_number_id VARCHAR(255),
    whatsapp_token TEXT,
    system_prompt TEXT,
    use_twilio BOOLEAN DEFAULT FALSE,
    whatsapp_number VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY,
    customer_phone_number VARCHAR(255) NOT NULL,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    current_state VARCHAR(50) NOT NULL DEFAULT 'idle',
    partial_booking_data JSONB DEFAULT '{}'::jsonb,
    last_messaged_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_client_customer UNIQUE (client_id, customer_phone_number),
    CONSTRAINT chk_current_state CHECK (current_state IN ('idle', 'collecting_name', 'collecting_date', 'collecting_service', 'awaiting_confirmation'))
);

CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    customer_name VARCHAR(255) NOT NULL,
    service VARCHAR(255) NOT NULL,
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'confirmed'
);

CREATE TABLE IF NOT EXISTS follow_ups (
    id UUID PRIMARY KEY,
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
    sent BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_conversations_lookup ON conversations (client_id, customer_phone_number);
CREATE INDEX IF NOT EXISTS idx_follow_ups_cron ON follow_ups (scheduled_time, sent);
```

### 3.1 Migration for Existing Databases
If you are upgrading from an older version of the database schema that does not have the conversation pause feature, execute the following SQL migration statement in your database SQL editor:

```sql
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT FALSE;
```

### 4. Configure Environment Variables
Copy `.env.example` to a new file `.env` and fill in your credentials:
```bash
cp .env.example .env
```

Review the configuration parameters:
- `DATABASE_URL`: Connection string of your Neon database.
- `GEMINI_API_KEY`: API Key obtained from Google AI Studio.
- `USE_TWILIO`: Toggle `true`/`false` to switch global fallback providers.

---

## Running Locally

### Start Development Server (with hot-reloading)
```bash
npm run dev
```

### Build & Run Production Server
```bash
npm run build
npm start
```

### Running Tests
We use Vitest for our high-fidelity, in-memory automated test suite:
```bash
npm run test
```

---

## Testing Locally with Twilio Sandbox

To test incoming webhooks on your local machine using the Twilio Sandbox:

1. **Start the Express Server**: Ensure your server is running on `http://localhost:3000`.
2. **Expose Local Server**: Use a tunneling tool like `ngrok` or `localtunnel` to expose your port:
   ```bash
   ngrok http 3000
   ```
3. **Configure Twilio Console**:
   - In your Twilio Console, navigate to **Messaging > Try it out > Send a WhatsApp Message**.
   - Under **Sandbox Settings**, set the **WHEN A MESSAGE COMES IN** webhook URL to your public tunnel address with the `/webhook` suffix:
     `https://your-tunnel-subdomain.ngrok-free.app/webhook`
   - Make sure the method is set to **HTTP POST**.
4. **Seed a Test Client**: Ensure a client matching your Twilio Sandbox sender number is seeded in your Neon Database (e.g., using `whatsapp_number = '+14155238886'`).
5. **Send a WhatsApp Message**: Text your Sandbox number (e.g., "Hello" or "I want to book an appointment") and observe the chatbot's response!

---

## Deploying to Railway

Railway is the recommended host for deploying this Express + Neon application.

### Step-by-Step Deployment:

1. **Login to Railway**: Open [Railway.app](https://railway.app/) and sign in.
2. **Create a New Project**:
   - Click **New Project** > **Deploy from GitHub repo**.
   - Choose the GitHub repository containing this codebase.
3. **Add Environment Variables**:
   Under the **Variables** tab of your new service, add the variables defined in your `.env`:
   - `DATABASE_URL` (link to your Neon Postgres)
   - `GEMINI_API_KEY`
   - `USE_TWILIO`
   - Twilio / Meta specific variables as needed.
4. **Configure Start Command**:
   Railway will automatically detect the `package.json` script and run:
   - Build step: `npm run build`
   - Start step: `npm start`
5. **Generate a Public Domain**:
   - Go to your service's **Settings** tab.
   - Under **Public Networking**, click **Generate Domain** to get a public URL.
6. **Set up Production Webhooks**:
   Update your Twilio Sandbox webhook or Meta Webhook subscription to route requests to:
   `https://your-railway-domain.up.railway.app/webhook`
