import { describe, test, expect, beforeEach, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import { GeminiService } from '../../src/services/gemini.service.js';

describe('GeminiService Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('should initialize Google AI Studio client with provided API Key', () => {
    new GeminiService({
      platform: 'studio',
      apiKey: 'test-studio-key',
    });

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-studio-key',
    });
  });

  test('should initialize Vertex AI client using Service Account Json', () => {
    const serviceAccountJson = JSON.stringify({
      project_id: 'sa-project-123',
    });

    new GeminiService({
      platform: 'vertex',
      project: 'fallback-project',
      location: 'us-east1',
      serviceAccountJson,
    });

    expect(GoogleGenAI).toHaveBeenCalledWith({
      vertexai: true,
      project: 'sa-project-123',
      location: 'us-east1',
      googleAuthOptions: {
        credentials: {
          project_id: 'sa-project-123',
        },
      },
    });
  });

  test('should fallback to API key when GCP_SERVICE_ACCOUNT_JSON parsing fails', () => {
    // Suppress console.error in this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    new GeminiService({
      platform: 'vertex',
      project: 'api-project',
      location: 'us-west1',
      serviceAccountJson: 'invalid-json',
      apiKey: 'api-key-123',
    });

    expect(GoogleGenAI).toHaveBeenCalledWith({
      vertexai: true,
      project: 'api-project',
      location: 'us-west1',
      auth: expect.any(Object),
    });

    consoleSpy.mockRestore();
  });

  test('should initialize Vertex AI client with API Key auth method when no SA JSON but key present', () => {
    new GeminiService({
      platform: 'vertex',
      project: 'api-project',
      location: 'us-west1',
      apiKey: 'api-key-123',
    });

    expect(GoogleGenAI).toHaveBeenCalledWith({
      vertexai: true,
      project: 'api-project',
      location: 'us-west1',
      auth: expect.any(Object),
    });
  });

  test('should initialize Vertex AI client using ADC when no SA JSON and no API Key', () => {
    const originalApiKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      new GeminiService({
        platform: 'vertex',
        project: 'adc-project',
        location: 'us-central1',
      });

      expect(GoogleGenAI).toHaveBeenCalledWith({
        vertexai: true,
        project: 'adc-project',
        location: 'us-central1',
      });
    } finally {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  test('should use injected aiClient direct reference if provided', async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({ text: 'mock text' }),
      },
    } as any;

    const service = new GeminiService({
      aiClient: mockClient,
    });

    expect(service.client).toBe(mockClient);
    expect(GoogleGenAI).not.toHaveBeenCalled();

    const response = await service.generateResponse('prompt', [], 'msg');
    expect(response).toBe('mock text');
  });
});
