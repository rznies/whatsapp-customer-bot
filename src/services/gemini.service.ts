import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

// The new SDK automatically resolves GEMINI_API_KEY from env, but we provide fallback to avoid crash during setup/tests if unset.
export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'DUMMY_KEY' });

export async function classifyIntent(message: string): Promise<'query' | 'booking' | 'followup-cancel' | 'other'> {
  if (!message || !message.trim()) {
    return 'other';
  }
  
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
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
      model: 'gemini-3.1-flash-lite-preview',
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
