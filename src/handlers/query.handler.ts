import { ClientConfig, sendMessage } from '../services/whatsapp.service.js';
import { generateResponse } from '../services/gemini.service.js';

export async function handleQuery(
  message: string,
  conversation: any,
  clientConfig: ClientConfig
): Promise<void> {
  const systemPrompt = clientConfig.system_prompt || 'You are a helpful assistant.';
  const reply = await generateResponse(systemPrompt, [], message);
  await sendMessage(conversation.customer_phone_number, reply, clientConfig);
}

export const queryHandler = {
  handle: handleQuery
};

