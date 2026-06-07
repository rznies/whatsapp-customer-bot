import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

let aiClient: GoogleGenAI;

if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
  try {
    const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
    aiClient = new GoogleGenAI({
      vertexai: true,
      project: credentials.project_id || 'rznies2',
      location: process.env.GCP_LOCATION || 'us-central1',
      googleAuthOptions: { credentials }
    });
  } catch (err) {
    console.error('Failed to parse GCP_SERVICE_ACCOUNT_JSON, falling back to API key:', err);
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'DUMMY_KEY' });
  }
} else {
  aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'DUMMY_KEY' });
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
