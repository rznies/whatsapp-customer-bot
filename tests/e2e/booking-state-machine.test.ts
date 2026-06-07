import { describe, test, expect } from 'vitest';
import {
  getNextState,
  extractName,
  parseBookingDate,
  isConfirmation,
  isCancellation,
  isInvalidDateReply,
  isInvalidServiceReply,
} from '../../src/handlers/booking-state-machine.js';

// ========================================================================
// Pure boundary tests — no mocks, no database, no async.
// These test the state machine as a pure function of (state, message, data).
// ========================================================================

describe('Booking State Machine — Pure Transitions', () => {

  // --- idle → collecting_name ---

  test('idle + any message → advance to collecting_name', () => {
    const result = getNextState('idle', 'I want to book an appointment', {});
    expect(result).toEqual({
      nextState: 'collecting_name',
      updatedData: {},
      action: 'advance',
    });
  });

  // --- collecting_name → collecting_date ---

  test('collecting_name + name → advance to collecting_date with extracted name', () => {
    const result = getNextState('collecting_name', 'Jane Smith', {});
    expect(result).toEqual({
      nextState: 'collecting_date',
      updatedData: { name: 'Jane Smith' },
      action: 'advance',
    });
  });

  test('collecting_name + "my name is Jane" → extracts "Jane"', () => {
    const result = getNextState('collecting_name', 'My name is Jane', {});
    expect(result.updatedData.name).toBe('Jane');
    expect(result.nextState).toBe('collecting_date');
    expect(result.action).toBe('advance');
  });

  // --- collecting_date → collecting_service ---

  test('collecting_date + date string → advance to collecting_service', () => {
    const result = getNextState('collecting_date', 'Friday at 2pm', { name: 'Jane' });
    expect(result).toEqual({
      nextState: 'collecting_service',
      updatedData: { name: 'Jane', date: 'Friday at 2pm' },
      action: 'advance',
    });
  });

  test('collecting_date preserves existing partial data', () => {
    const result = getNextState('collecting_date', 'Tomorrow', { name: 'Bob' });
    expect(result.updatedData).toEqual({ name: 'Bob', date: 'Tomorrow' });
  });

  // --- collecting_service → awaiting_confirmation ---

  test('collecting_service + service → advance to awaiting_confirmation', () => {
    const result = getNextState('collecting_service', 'Haircut', { name: 'Jane', date: 'Friday' });
    expect(result).toEqual({
      nextState: 'awaiting_confirmation',
      updatedData: { name: 'Jane', date: 'Friday', service: 'Haircut' },
      action: 'advance',
    });
  });

  // --- awaiting_confirmation ---

  test('awaiting_confirmation + "yes" → confirm', () => {
    const data = { name: 'Jane', date: '2026-06-10', service: 'Haircut' };
    const result = getNextState('awaiting_confirmation', 'yes', data);
    expect(result.action).toBe('confirm');
    expect(result.nextState).toBe('idle');
    expect(result.updatedData).toEqual(data);
  });

  test('awaiting_confirmation + "confirm" → confirm', () => {
    const data = { name: 'Jane', date: '2026-06-10', service: 'Haircut' };
    const result = getNextState('awaiting_confirmation', 'confirm', data);
    expect(result.action).toBe('confirm');
  });

  test('awaiting_confirmation + "yeah" → confirm', () => {
    const data = { name: 'Jane', date: '2026-06-10', service: 'Haircut' };
    const result = getNextState('awaiting_confirmation', 'yeah', data);
    expect(result.action).toBe('confirm');
  });

  test('awaiting_confirmation + "y" → confirm', () => {
    const data = { name: 'Jane', date: '2026-06-10', service: 'Haircut' };
    const result = getNextState('awaiting_confirmation', 'y', data);
    expect(result.action).toBe('confirm');
  });

  test('awaiting_confirmation + "no" → cancel', () => {
    const data = { name: 'Jane', date: '2026-06-10', service: 'Haircut' };
    const result = getNextState('awaiting_confirmation', 'no', data);
    expect(result.action).toBe('cancel');
    expect(result.nextState).toBe('idle');
    expect(result.updatedData).toEqual({});
  });

  test('awaiting_confirmation + "nah" → cancel', () => {
    const result = getNextState('awaiting_confirmation', 'nah', { name: 'Jane', date: 'Fri', service: 'Haircut' });
    expect(result.action).toBe('cancel');
  });

  // --- Mid-flow cancellation ---

  test('collecting_name + "cancel" → cancel to idle', () => {
    const result = getNextState('collecting_name', 'cancel', {});
    expect(result).toEqual({
      nextState: 'idle',
      updatedData: {},
      action: 'cancel',
    });
  });

  test('collecting_date + "cancel" → cancel to idle', () => {
    const result = getNextState('collecting_date', 'cancel', { name: 'Jane' });
    expect(result).toEqual({
      nextState: 'idle',
      updatedData: {},
      action: 'cancel',
    });
  });

  test('collecting_service + "cancel" → cancel to idle', () => {
    const result = getNextState('collecting_service', 'cancel', { name: 'Jane', date: 'Fri' });
    expect(result).toEqual({
      nextState: 'idle',
      updatedData: {},
      action: 'cancel',
    });
  });

  test('awaiting_confirmation + "cancel" → cancel to idle', () => {
    const result = getNextState('awaiting_confirmation', 'cancel', { name: 'Jane', date: 'Fri', service: 'Haircut' });
    expect(result).toEqual({
      nextState: 'idle',
      updatedData: {},
      action: 'cancel',
    });
  });

  test('idle + "cancel" → cancel', () => {
    const result = getNextState('idle', 'cancel', {});
    expect(result.action).toBe('cancel');
    expect(result.nextState).toBe('idle');
  });

  // --- Unknown state fallback ---

  test('unknown state → cancel to idle', () => {
    const result = getNextState('some_unknown_state' as any, 'hello', {});
    expect(result).toEqual({
      nextState: 'idle',
      updatedData: {},
      action: 'cancel',
    });
  });
});

// ========================================================================
// Pure helper function tests
// ========================================================================

describe('extractName', () => {
  test('extracts name from "My name is Jane Smith"', () => {
    expect(extractName('My name is Jane Smith')).toBe('Jane Smith');
  });

  test('extracts name from "I am Bob"', () => {
    expect(extractName('I am Bob')).toBe('Bob');
  });

  test('extracts name from "call me Alice"', () => {
    expect(extractName('call me Alice')).toBe('Alice');
  });

  test('extracts name from "this is Charlie"', () => {
    expect(extractName('this is Charlie')).toBe('Charlie');
  });

  test('returns trimmed input when no pattern matches', () => {
    expect(extractName('  Jane  ')).toBe('Jane');
  });

  test('returns plain text as-is', () => {
    expect(extractName('Jane Smith')).toBe('Jane Smith');
  });
});

describe('parseBookingDate', () => {
  test('parses ISO date string', () => {
    const result = parseBookingDate('2026-06-10');
    expect(result.getTime()).not.toBeNaN();
  });

  test('handles "tomorrow" keyword', () => {
    const result = parseBookingDate('tomorrow at 3pm');
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(result.getDate()).toBe(tomorrow.getDate());
    expect(result.getHours()).toBe(10);
  });

  test('returns tomorrow as fallback for unparseable dates', () => {
    const result = parseBookingDate('whenever you want');
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(result.getDate()).toBe(tomorrow.getDate());
  });
});

describe('isConfirmation', () => {
  test('"yes" → true', () => expect(isConfirmation('yes')).toBe(true));
  test('"Yes" → true', () => expect(isConfirmation('Yes')).toBe(true));
  test('"confirm" → true', () => expect(isConfirmation('confirm')).toBe(true));
  test('"yeah" → true', () => expect(isConfirmation('yeah')).toBe(true));
  test('"y" → true', () => expect(isConfirmation('y')).toBe(true));
  test('"no" → false', () => expect(isConfirmation('no')).toBe(false));
  test('"nah" → false', () => expect(isConfirmation('nah')).toBe(false));
  test('"maybe" → false', () => expect(isConfirmation('maybe')).toBe(false));
});

describe('isCancellation', () => {
  test('"cancel" → true', () => expect(isCancellation('cancel')).toBe(true));
  test('"Cancel" → true', () => expect(isCancellation('Cancel')).toBe(true));
  test('"  cancel  " → true', () => expect(isCancellation('  cancel  ')).toBe(true));
  test('"cancellation" → false', () => expect(isCancellation('cancellation')).toBe(false));
  test('"please cancel" → false', () => expect(isCancellation('please cancel')).toBe(false));
});

describe('isInvalidDateReply', () => {
  test('"Please provide a valid date" → true', () => {
    expect(isInvalidDateReply('Please provide a valid date')).toBe(true);
  });
  test('"I don\'t understand your date" → true', () => {
    expect(isInvalidDateReply("I don't understand your date")).toBe(true);
  });
  test('"That date is invalid" → true', () => {
    expect(isInvalidDateReply('That date is invalid')).toBe(true);
  });
  test('"Great, Friday at 2pm works" → false', () => {
    expect(isInvalidDateReply('Great, Friday at 2pm works')).toBe(false);
  });
});

describe('isInvalidServiceReply', () => {
  test('"Please select one of our services" → true', () => {
    expect(isInvalidServiceReply('Please select one of our services')).toBe(true);
  });
  test('"We only offer haircut, color, styling" → true', () => {
    expect(isInvalidServiceReply('We only offer haircut, color, styling')).toBe(true);
  });
  test('"Sorry, that service is not available" → true', () => {
    expect(isInvalidServiceReply('Sorry, that service is not available')).toBe(true);
  });
  test('"That is an invalid option" → true', () => {
    expect(isInvalidServiceReply('That is an invalid option')).toBe(true);
  });
  test('"Great choice! Haircut it is." → false', () => {
    expect(isInvalidServiceReply('Great choice! Haircut it is.')).toBe(false);
  });
});
