import twilio from 'twilio';
import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

export interface ClientConfig {
  id: string;
  name: string;
  meta_phone_number_id?: string | null;
  whatsapp_token?: string | null;
  system_prompt?: string | null;
  use_twilio?: boolean;
  whatsapp_number?: string | null;
}

function makeHttpsPost(url: string, headers: any, body: any, timeoutMs: number): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      method: 'POST',
      headers,
      timeout: timeoutMs
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode || 200,
          text: async () => data
        });
      });
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Meta API request timed out'));
    });
    
    req.write(JSON.stringify(body));
    req.end();
  });
}

export async function sendMessage(to: string, text: string, clientConfig: ClientConfig): Promise<void> {
  if (text.length > 4096) {
    throw new Error('Message length exceeds limit of 4096 characters');
  }

  const useTwilio = clientConfig.use_twilio ?? (process.env.USE_TWILIO === 'true');
  
  if (useTwilio) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = clientConfig.whatsapp_number || process.env.TWILIO_FROM_NUMBER || '+14155238886';
    
    if (!accountSid || !authToken) {
      throw new Error('Twilio credentials missing');
    }
    
    // Normalize phone number for Twilio sandbox
    let formattedTo = to;
    if (!formattedTo.startsWith('whatsapp:')) {
      const cleanTo = formattedTo.replace(/[^\d+]/g, '');
      formattedTo = `whatsapp:${cleanTo}`;
    } else {
      const cleanTo = formattedTo.replace('whatsapp:', '').replace(/[^\d+]/g, '');
      formattedTo = `whatsapp:${cleanTo}`;
    }
    let formattedFrom = fromNumber;
    if (!formattedFrom.startsWith('whatsapp:')) {
      const cleanFrom = formattedFrom.replace(/[^\d+]/g, '');
      formattedFrom = `whatsapp:${cleanFrom}`;
    } else {
      const cleanFrom = formattedFrom.replace('whatsapp:', '').replace(/[^\d+]/g, '');
      formattedFrom = `whatsapp:${cleanFrom}`;
    }
    
    try {
      const client = twilio(accountSid, authToken);
      await client.messages.create({
        to: formattedTo,
        from: formattedFrom,
        body: text,
      });
    } catch (error: any) {
      throw new Error(`Twilio dispatch failed: ${error.message}`);
    }
  } else {
    const phoneId = clientConfig.meta_phone_number_id;
    const token = clientConfig.whatsapp_token;
    
    if (!phoneId || !token) {
      throw new Error('Meta Graph API credentials missing');
    }
    
    // Normalize phone number for Meta (digits only, e.g. 12025550199)
    const cleanTo = to.replace(/whatsapp:/g, '').replace(/[^\d]/g, '');
    
    const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;
    
    try {
      const response = await makeHttpsPost(url, {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }, {
        messaging_product: 'whatsapp',
        to: cleanTo,
        type: 'text',
        text: { body: text },
      }, 5000);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Meta API error: ${response.status} - ${errorText}`);
      }
    } catch (error: any) {
      throw error;
    }
  }
}
