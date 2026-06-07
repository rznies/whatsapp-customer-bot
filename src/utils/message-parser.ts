export interface NormalizedMessage {
  isTwilio: boolean;
  messageId: string;
  fromNumber: string;
  toNumber?: string;
  messageText: string;
  metaPhoneId?: string;
}

export function parseWebhookBody(body: any): NormalizedMessage | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  // 1. Distinguish between Twilio and Meta payload
  if (body.From && body.To) {
    // Twilio payload
    const fromNumber = body.From.replace('whatsapp:', '').trim();
    const toNumber = body.To.replace('whatsapp:', '').trim();
    const messageText = body.Body || '';
    const messageId = body.MessageSid;

    if (!fromNumber || !toNumber) {
      console.warn('Twilio payload missing From or To parameter');
      return null;
    }

    return {
      isTwilio: true,
      messageId,
      fromNumber,
      toNumber,
      messageText,
    };
  } else if (body.object === 'whatsapp_business_account') {
    // Meta JSON payload
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const metadata = value?.metadata;
    const message = value?.messages?.[0];

    if (!message) {
      // Empty payload, ignore gracefully
      return null;
    }

    let fromNumber = message.from; // format digits only, e.g. 12025550199
    if (fromNumber && !fromNumber.startsWith('+')) {
      fromNumber = '+' + fromNumber;
    }
    const metaPhoneId = metadata?.phone_number_id;
    const messageText = message.text?.body || '';
    const messageId = message.id;

    if (!fromNumber || !metaPhoneId) {
      console.warn('Meta payload missing from or metadata.phone_number_id');
      return null;
    }

    return {
      isTwilio: false,
      messageId,
      fromNumber,
      metaPhoneId,
      messageText,
    };
  } else {
    // Unknown payload format
    console.warn('Unknown webhook payload received');
    return null;
  }
}
