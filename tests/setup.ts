import { vi, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.TWILIO_ACCOUNT_SID = 'AC_DUMMY_SID';
process.env.TWILIO_AUTH_TOKEN = 'DUMMY_TOKEN';
process.env.META_WHATSAPP_TOKEN = 'EAAGxx887766aaBBccDDeeFF';

// 1. Create a high-fidelity pg-mem database instance
const dbInstance = newDb();
const mockPg = dbInstance.adapters.createPg();

// Register the PostgreSQL RIGHT function in pg-mem
dbInstance.public.registerFunction({
  name: 'right',
  args: ['text', 'integer'],
  returns: 'text',
  implementation: (str: string, n: number) => {
    if (str == null) return null;
    const len = str.length;
    if (n <= 0) return '';
    if (n >= len) return str;
    return str.substring(len - n);
  }
});

// 2. Export mock instances so tests can import and assert on them
export const mockDatabase = dbInstance;

export const mockTwilioClient = {
  messages: {
    create: vi.fn().mockResolvedValue({ sid: 'SM123' }),
  },
};

export const mockGeminiClient = {
  models: {
    generateContent: vi.fn().mockResolvedValue({
      text: 'mocked response',
    }),
  },
};

// 3. Mock modules globally
vi.mock('pg', () => {
  return {
    default: mockPg,
    Pool: mockPg.Pool,
    Client: mockPg.Client,
  };
});

vi.mock('@neondatabase/serverless', () => {
  return {
    Pool: mockPg.Pool,
    Client: mockPg.Client,
  };
});

vi.mock('twilio', () => {
  return {
    default: vi.fn().mockReturnValue(mockTwilioClient),
  };
});

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(function () {
      return mockGeminiClient;
    }),
  };
});

// 4. Initialize Database Schema
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, '../src/db/schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

// Run the schema.sql against the pg-mem instance
dbInstance.public.none(schemaSql);

// 5. Clean up mocks before each test, using mockReset to clear queues
beforeEach(() => {
  mockTwilioClient.messages.create.mockReset();
  mockTwilioClient.messages.create.mockResolvedValue({ sid: 'SM123' });

  mockGeminiClient.models.generateContent.mockReset();
  mockGeminiClient.models.generateContent.mockResolvedValue({
    text: 'mocked response',
  });
});
