-- Migration: Add paused column to conversations table
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT FALSE;
