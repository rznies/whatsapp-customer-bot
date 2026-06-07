import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

let aiClient: GoogleGenAI;

const isVertex = process.env.GEMINI_PLATFORM === 'vertex' || process.env.USE_VERTEX_AI === 'true';

if (isVertex) {
  const project = process.env.GCP_PROJECT || 'rznies2';
  const location = process.env.GCP_LOCATION || 'us-central1';

  if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
    try {
      const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
      aiClient = new GoogleGenAI({
        vertexai: true,
        project: credentials.project_id || project,
        location: location,
        googleAuthOptions: { credentials }
      });
      console.log('Initialized Vertex AI client using GCP_SERVICE_ACCOUNT_JSON.');
    } catch (err) {
      console.error('Failed to parse GCP_SERVICE_ACCOUNT_JSON, falling back to API key:', err);
      aiClient = initializeVertexWithApiKey(project, location);
    }
  } else if (process.env.GEMINI_API_KEY) {
    aiClient = initializeVertexWithApiKey(project, location);
  } else {
    aiClient = new GoogleGenAI({
      vertexai: true,
      project: project,
      location: location
    });
    console.log('Initialized Vertex AI client using Application Default Credentials (ADC).');
  }
} else {
  aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'DUMMY_KEY' });
  console.log('Initialized Google AI Studio client.');
}

function initializeVertexWithApiKey(project: string, location: string): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
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

export const ai = aiClient;

const modelName = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';

export async function classifyIntent(message: string): Promise<'query' | 'booking' | 'followup-cancel' | 'other'> {
  if (!message || !message.trim()) {
    return 'other';
  }
  
  try {
    const response = await ai.models.generateContent({
      model: modelName,
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

export async function generateResponse(
  systemPrompt: string,
  conversationHistory: string[],
  userMessage: string
): Promise<string> {
  try {
    const contents = [
      ...conversationHistory.map(msg => ({ role: 'user' as const, parts: [{ text: msg }] })),
      { role: 'user' as const, parts: [{ text: userMessage }] }
    ];
    
    const response = await ai.models.generateContent({
      model: modelName,
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
