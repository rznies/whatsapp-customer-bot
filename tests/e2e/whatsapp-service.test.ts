import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';
import { mockTwilioClient } from '../setup.js';
import { sendMessage, ClientConfig } from '../../src/services/whatsapp.service.js';

describe('F3: WhatsApp Provider Service E2E Tests', () => {
  const clientConfigTwilio: ClientConfig = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Bella Hair Salon',
    use_twilio: true,
    whatsapp_number: '+14155238886',
  };

  const clientConfigMeta: ClientConfig = {
    id: '6a2b8400-e29b-41d4-a716-446655440111',
    name: 'Apex Auto Repair',
    use_twilio: false,
    meta_phone_number_id: '209938762458901',
    whatsapp_token: 'EAAGyy998877bbCCddEEffGG',
  };

  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token123';
    
    mockTwilioClient.messages.create.mockClear();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test('TC-3.1.1: Twilio Dispatch via SDK', async () => {
    await sendMessage('+12025550199', 'Hello', clientConfigTwilio);

    expect(mockTwilioClient.messages.create).toHaveBeenCalledTimes(1);
    expect(mockTwilioClient.messages.create).toHaveBeenCalledWith({
      to: 'whatsapp:+12025550199',
      from: 'whatsapp:+14155238886',
      body: 'Hello',
    });
  });

  test('TC-3.1.2: Meta Dispatch via Graph API', async () => {
    const scope = nock('https://graph.facebook.com')
      .post('/v17.0/209938762458901/messages', {
        messaging_product: 'whatsapp',
        to: '12025550199',
        type: 'text',
        text: { body: 'Hello' },
      })
      .reply(200, { message_id: 'wam.123' });

    await sendMessage('+12025550199', 'Hello', clientConfigMeta);
    scope.done();
  });

  test('TC-3.1.3: Config-based Twilio Router Selection', async () => {
    await sendMessage('+12025550199', 'Hello', clientConfigTwilio);
    expect(mockTwilioClient.messages.create).toHaveBeenCalledTimes(1);
  });

  test('TC-3.1.4: Config-based Meta Router Selection', async () => {
    const scope = nock('https://graph.facebook.com')
      .post('/v17.0/209938762458901/messages')
      .reply(200, { message_id: 'wam.123' });

    await sendMessage('+12025550199', 'Hello', clientConfigMeta);
    scope.done();
  });

  test('TC-3.1.5: Phone Number Format Normalization', async () => {
    // For Twilio
    await sendMessage('+1 (202) 555-0199', 'Hello', clientConfigTwilio);
    expect(mockTwilioClient.messages.create).toHaveBeenLastCalledWith({
      to: 'whatsapp:+12025550199',
      from: 'whatsapp:+14155238886',
      body: 'Hello',
    });

    // For Meta
    const scope = nock('https://graph.facebook.com')
      .post('/v17.0/209938762458901/messages', {
        messaging_product: 'whatsapp',
        to: '12025550199',
        type: 'text',
        text: { body: 'Hello' },
      })
      .reply(200, { message_id: 'wam.123' });

    await sendMessage('whatsapp:+12025550199', 'Hello', clientConfigMeta);
    scope.done();
  });

  test('TC-3.2.1: Invalid Twilio Account Credentials', async () => {
    mockTwilioClient.messages.create.mockRejectedValueOnce(new Error('Unauthorized'));

    await expect(
      sendMessage('+12025550199', 'Hello', clientConfigTwilio)
    ).rejects.toThrow('Twilio dispatch failed: Unauthorized');
  });

  test('TC-3.2.2: Meta API 401 Unauthorized Response', async () => {
    nock('https://graph.facebook.com')
      .post('/v17.0/209938762458901/messages')
      .reply(401, 'Invalid OAuth access token');

    await expect(
      sendMessage('+12025550199', 'Hello', clientConfigMeta)
    ).rejects.toThrow('Meta API error: 401 - Invalid OAuth access token');
  });

  test('TC-3.2.3: Emoji & Multi-language Unicode Support', async () => {
    const text = '💇‍♀️ Book your style today! ✨ 💇‍♂️ (こんにちは)';

    const scope = nock('https://graph.facebook.com')
      .post('/v17.0/209938762458901/messages', {
        messaging_product: 'whatsapp',
        to: '12025550199',
        type: 'text',
        text: { body: text },
      })
      .reply(200, { message_id: 'wam.123' });

    await sendMessage('+12025550199', text, clientConfigMeta);
    scope.done();
  });

  test('TC-3.2.4: Message Length Limit Boundary Handling', async () => {
    const longText = 'a'.repeat(5000);
    await expect(
      sendMessage('+12025550199', longText, clientConfigTwilio)
    ).rejects.toThrow('Message length exceeds limit');
  });

  test('TC-3.2.5: Gateway Timeout Protection', async () => {
    vi.useFakeTimers();

    nock('https://graph.facebook.com')
      .post('/v17.0/209938762458901/messages')
      .delayConnection(15000)
      .reply(200, { message_id: 'wam.123' });

    const sendPromise = sendMessage('+12025550199', 'Hello', clientConfigMeta);

    // Fast-forward by 6 seconds to trigger AbortController timeout
    vi.advanceTimersByTime(6000);

    await expect(sendPromise).rejects.toThrow('Meta API request timed out');

    vi.useRealTimers();
  });
});
