import { describe, test, expect } from 'vitest';
import { parseWebhookBody } from '../../src/utils/message-parser.js';

describe('message-parser Unit Tests', () => {
  test('should return null for invalid or empty inputs', () => {
    expect(parseWebhookBody(null)).toBeNull();
    expect(parseWebhookBody(undefined)).toBeNull();
    expect(parseWebhookBody('string')).toBeNull();
    expect(parseWebhookBody({})).toBeNull();
  });

  test('should correctly parse valid Twilio payload', () => {
    const twilioPayload = {
      From: 'whatsapp:+12025550199',
      To: 'whatsapp:+14155238886',
      Body: 'Hey, I want to book',
      MessageSid: 'SM123',
    };

    const result = parseWebhookBody(twilioPayload);
    expect(result).toEqual({
      isTwilio: true,
      messageId: 'SM123',
      fromNumber: '+12025550199',
      toNumber: '+14155238886',
      messageText: 'Hey, I want to book',
    });
  });

  test('should return null for Twilio payload with missing From or To', () => {
    expect(parseWebhookBody({ From: 'whatsapp:+12025550199', Body: 'text' })).toBeNull();
    expect(parseWebhookBody({ To: 'whatsapp:+14155238886', Body: 'text' })).toBeNull();
  });

  test('should correctly parse valid Meta payload', () => {
    const metaPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: '109927651347890',
                  display_phone_number: '14155238886',
                },
                messages: [
                  {
                    from: '12025550199',
                    id: 'wamid.HBgLMTIwMjU1NTAxOTk=',
                    timestamp: '1675903962',
                    text: { body: 'Hello!' },
                    type: 'text',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const result = parseWebhookBody(metaPayload);
    expect(result).toEqual({
      isTwilio: false,
      messageId: 'wamid.HBgLMTIwMjU1NTAxOTk=',
      fromNumber: '+12025550199',
      metaPhoneId: '109927651347890',
      messageText: 'Hello!',
    });
  });

  test('should prepend + to Meta fromNumber if it is missing', () => {
    const metaPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  {
                    from: '+12025550199',
                    id: 'wamid.123',
                    text: { body: 'Hello!' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = parseWebhookBody(metaPayload);
    expect(result?.fromNumber).toBe('+12025550199');
  });

  test('should return null for Meta payload with missing messages array', () => {
    const metaPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '109927651347890' },
                messages: [],
              },
            },
          ],
        },
      ],
    };

    expect(parseWebhookBody(metaPayload)).toBeNull();
  });

  test('should return null for Meta payload with missing critical params', () => {
    const missingFrom = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '123' },
                messages: [{ id: 'wamid.123' }],
              },
            },
          ],
        },
      ],
    };

    const missingPhoneId = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '123', id: 'wamid.123' }],
              },
            },
          ],
        },
      ],
    };

    expect(parseWebhookBody(missingFrom)).toBeNull();
    expect(parseWebhookBody(missingPhoneId)).toBeNull();
  });
});
