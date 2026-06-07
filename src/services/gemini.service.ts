import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

export interface GeminiConfig {
  apiKey?: string;
  platform?: 'studio' | 'vertex';
  project?: string;
  location?: string;
  serviceAccountJson?: string;
  modelName?: string;
  aiClient?: GoogleGenAI;
}

export class GeminiService {
  private ai: GoogleGenAI;
  private modelName: string;

  constructor(config: GeminiConfig = {}) {
    const platform = config.platform || (process.env.GEMINI_PLATFORM === 'vertex' || process.env.USE_VERTEX_AI === 'true' ? 'vertex' : 'studio');
    this.modelName = config.modelName || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';

    if (config.aiClient) {
      this.ai = config.aiClient;
      return;
    }

    if (platform === 'vertex') {
      const project = config.project || process.env.GCP_PROJECT || 'rznies2';
      const location = config.location || process.env.GCP_LOCATION || 'us-central1';
      const serviceAccountJson = config.serviceAccountJson || process.env.GCP_SERVICE_ACCOUNT_JSON;

      if (serviceAccountJson) {
        try {
          const credentials = JSON.parse(serviceAccountJson);
          this.ai = new GoogleGenAI({
            vertexai: true,
            project: credentials.project_id || project,
            location: location,
            googleAuthOptions: { credentials }
          });
          console.log('Initialized Vertex AI client using GCP_SERVICE_ACCOUNT_JSON.');
        } catch (err) {
          console.error('Failed to parse GCP_SERVICE_ACCOUNT_JSON, falling back to API key:', err);
          this.ai = this.initializeVertexWithApiKey(project, location, config.apiKey || process.env.GEMINI_API_KEY);
        }
      } else {
        const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
        if (apiKey) {
          this.ai = this.initializeVertexWithApiKey(project, location, apiKey);
        } else {
          this.ai = new GoogleGenAI({
            vertexai: true,
            project: project,
            location: location
          });
          console.log('Initialized Vertex AI client using Application Default Credentials (ADC).');
        }
      }
    } else {
      const apiKey = config.apiKey || process.env.GEMINI_API_KEY || 'DUMMY_KEY';
      this.ai = new GoogleGenAI({ apiKey });
      console.log('Initialized Google AI Studio client.');
    }
  }

  private initializeVertexWithApiKey(project: string, location: string, apiKey?: string): GoogleGenAI {
    console.log('Initializing Vertex AI client using Service-Account Bound API Key.');
    return new GoogleGenAI({
      vertexai: true,
      project: project,
      location: location,
      auth: {
        async addAuthHeaders(headers: Headers): Promise<void> {
          if (apiKey) {
            headers.append('x-goog-api-key', apiKey);
          }
        }
      }
    });
  }

  public get client(): GoogleGenAI {
    return this.ai;
  }

  public async classifyIntent(message: string): Promise<'query' | 'booking' | 'followup-cancel' | 'other'> {
    if (!message || !message.trim()) {
      return 'other';
    }
    
    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: `Classify the user intent from this message into one of the following: 'query', 'booking', 'followup-cancel', 'other'.
Message: "${message}"
Response must be only the intent word.`,
      });
      
      const text = response?.text?.trim().toLowerCase() || 'other';
      if (text.includes('query')) return 'query';
      if (text.includes('booking')) return 'booking';
      if (text.includes('followup-cancel')) return 'followup-cancel';
      return 'other';
    } catch (error) {
      console.error('Error in classifyIntent:', error);
      throw error;
    }
  }

  public async generateResponse(
    systemPrompt: string,
    conversationHistory: string[],
    userMessage: string
  ): Promise<string> {
    try {
      const contents = [
        ...conversationHistory.map(msg => ({ role: 'user' as const, parts: [{ text: msg }] })),
        { role: 'user' as const, parts: [{ text: userMessage }] }
      ];
      
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        config: {
          systemInstruction: systemPrompt,
        },
        contents,
      });
      
      return response.text || '';
    } catch (error) {
      console.error('Error in generateResponse:', error);
      throw error;
    }
  }
}

// Lazy-initialized default service instance
let defaultServiceInstance: GeminiService | null = null;

export function getDefaultGeminiService(): GeminiService {
  if (!defaultServiceInstance) {
    defaultServiceInstance = new GeminiService();
  }
  return defaultServiceInstance;
}

// Backward compatible exports
export const ai = new Proxy({} as any, {
  get(target, prop, receiver) {
    return Reflect.get(getDefaultGeminiService().client, prop, receiver);
  }
}) as GoogleGenAI;

export async function classifyIntent(message: string): Promise<'query' | 'booking' | 'followup-cancel' | 'other'> {
  return getDefaultGeminiService().classifyIntent(message);
}

export async function generateResponse(
  systemPrompt: string,
  conversationHistory: string[],
  userMessage: string
): Promise<string> {
  return getDefaultGeminiService().generateResponse(systemPrompt, conversationHistory, userMessage);
}
