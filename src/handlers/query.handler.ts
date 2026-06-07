import { ClientConfig, sendMessage } from '../services/whatsapp.service.js';
import { generateResponse } from '../services/gemini.service.js';

export interface QueryDeps {
  generateResponse(systemPrompt: string, history: string[], message: string): Promise<string>;
  sendMessage(to: string, text: string, config: ClientConfig): Promise<void>;
}

export function createQueryHandler(deps: QueryDeps) {
  const { generateResponse: genResponse, sendMessage: send } = deps;

  async function handle(
    message: string,
    conversation: any,
    clientConfig: ClientConfig
  ): Promise<void> {
    const systemPrompt = clientConfig.system_prompt || 'You are a helpful assistant.';
    const reply = await genResponse(systemPrompt, [], message);
    await send(conversation.customer_phone_number, reply, clientConfig);
  }

  return { handle };
}

// Backward-compatible default instance
export const queryHandler = createQueryHandler({
  generateResponse,
  sendMessage,
});
