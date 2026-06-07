export type BookingState = 'idle' | 'collecting_name' | 'collecting_date' | 'collecting_service' | 'awaiting_confirmation';

export interface PartialBooking {
  name?: string;
  date?: string;
  service?: string;
}

export interface StateDecision {
  nextState: BookingState;
  updatedData: PartialBooking;
  action: 'advance' | 'retry' | 'confirm' | 'cancel';
}

export function extractName(text: string): string {
  const match = text.match(/(?:my name is|i am|call me|this is)\s+([a-zA-Z\s]+)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return text.trim();
}

export function parseBookingDate(dateStr: string): Date {
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (dateStr.toLowerCase().includes('tomorrow')) {
    tomorrow.setHours(10, 0, 0, 0);
    return tomorrow;
  }
  return tomorrow;
}

export function isConfirmation(message: string): boolean {
  const lowerMsg = message.toLowerCase().trim();
  return lowerMsg.includes('yes') || lowerMsg.includes('confirm') || lowerMsg.includes('yeah') || lowerMsg === 'y';
}

export function isCancellation(message: string): boolean {
  return message.toLowerCase().trim() === 'cancel';
}

export function isInvalidDateReply(reply: string): boolean {
  const lowerReply = reply.toLowerCase();
  return lowerReply.includes('valid date') || lowerReply.includes('understand') || lowerReply.includes('invalid');
}

export function isInvalidServiceReply(reply: string): boolean {
  const lowerReply = reply.toLowerCase();
  return lowerReply.includes('select one') || lowerReply.includes('only offer') || lowerReply.includes('invalid') || lowerReply.includes('sorry');
}

export function getNextState(
  currentState: BookingState,
  message: string,
  partialData: PartialBooking,
  options?: { geminiReply?: string; intent?: string }
): StateDecision {
  const intent = options?.intent;

  // 1. Cancellation check
  if (
    isCancellation(message) ||
    (currentState === 'idle' && intent === 'followup-cancel')
  ) {
    return {
      nextState: 'idle',
      updatedData: {},
      action: 'cancel'
    };
  }

  switch (currentState) {
    case 'idle':
      return {
        nextState: 'collecting_name',
        updatedData: {},
        action: 'advance'
      };

    case 'collecting_name':
      return {
        nextState: 'collecting_date',
        updatedData: {
          ...partialData,
          name: extractName(message)
        },
        action: 'advance'
      };

    case 'collecting_date':
      if (options?.geminiReply && isInvalidDateReply(options.geminiReply)) {
        return {
          nextState: 'collecting_date',
          updatedData: partialData,
          action: 'retry'
        };
      }
      return {
        nextState: 'collecting_service',
        updatedData: {
          ...partialData,
          date: message
        },
        action: 'advance'
      };

    case 'collecting_service':
      if (options?.geminiReply && isInvalidServiceReply(options.geminiReply)) {
        return {
          nextState: 'collecting_service',
          updatedData: partialData,
          action: 'retry'
        };
      }
      return {
        nextState: 'awaiting_confirmation',
        updatedData: {
          ...partialData,
          service: message
        },
        action: 'advance'
      };

    case 'awaiting_confirmation':
      if (isConfirmation(message)) {
        return {
          nextState: 'idle',
          updatedData: partialData,
          action: 'confirm'
        };
      } else {
        return {
          nextState: 'idle',
          updatedData: {},
          action: 'cancel'
        };
      }

    default:
      return {
        nextState: 'idle',
        updatedData: {},
        action: 'cancel'
      };
  }
}
