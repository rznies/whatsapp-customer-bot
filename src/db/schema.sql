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
    paused BOOLEAN DEFAULT FALSE,
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

