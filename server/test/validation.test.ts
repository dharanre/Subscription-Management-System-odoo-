import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError, kind, pagingSchema, parse, text } from '../src/lib/http.js';
import { dateSchema, moneySchema, percentSchema } from '../src/lib/money.js';
import { METHODS } from '../src/lib/paymentRows.js';
import { passwordSchema } from '../src/routes/auth.js';
import { recordPaymentSchema } from '../src/routes/payments.js';

/** The first message a schema gives for an input, or 'OK' when it is accepted. */
const say = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? 'OK' : (result.error.issues[0]?.message ?? '?');
};

describe('the wording of validation messages', () => {
  it('tells a missing value from one of the wrong type', () => {
    const quantity = z.number(kind('Quantity must be a number', 'Quantity is required'));
    expect(say(quantity, undefined)).toBe('Quantity is required');
    expect(say(quantity, 'three')).toBe('Quantity must be a number');
    expect(say(quantity, null)).toBe('Quantity must be a number');
    expect(say(quantity, 3)).toBe('OK');
  });

  it('says "Required" when only the wrong-type wording was given', () => {
    const flag = z.boolean(kind('isActive must be true or false'));
    expect(say(flag, undefined)).toBe('Required');
    expect(say(flag, 'yes')).toBe('isActive must be true or false');
  });

  it('words text fields as sentences', () => {
    expect(say(z.string(text('Name')), undefined)).toBe('Name is required');
    expect(say(z.string(text('Name')), 7)).toBe('Name must be text');
  });

  it('keeps the specific message of every further check', () => {
    expect(say(z.number().int('Quantity must be a whole number'), 1.5)).toBe('Quantity must be a whole number');
    expect(say(z.array(z.number()).max(2, 'Too many products'), [1, 2, 3])).toBe('Too many products');
    expect(say(z.array(z.number(), kind('productIds must be a list')), 'x')).toBe('productIds must be a list');
  });

  it('gives money amounts, percentages and dates their own words', () => {
    expect(say(moneySchema('Amount'), undefined)).toBe('Amount is required');
    expect(say(moneySchema('Amount'), 'abc')).toBe('Amount must be a number');
    expect(say(moneySchema('Amount'), -1)).toBe('Amount cannot be negative');
    expect(say(moneySchema('Amount'), 1.234)).toBe('Amount can have at most 2 decimal places');
    expect(say(moneySchema('Amount'), 1e9)).toBe('Amount is too large');
    expect(say(percentSchema('Rate'), 101)).toBe('Rate cannot exceed 100');
    expect(say(dateSchema('From'), undefined)).toBe('From is required');
    expect(say(dateSchema('From'), 5)).toBe('From must be a date');
    expect(say(dateSchema('From'), '26-1-1')).toBe('From must be a date (YYYY-MM-DD)');
    expect(say(dateSchema('From'), '2026-02-30')).toBe('From is not a real calendar date');
  });

  it('turns amounts into minor units and rates into basis points', () => {
    expect(moneySchema('Amount').parse(12.5)).toBe(1250);
    expect(moneySchema('Amount').parse(0.29)).toBe(29);
    expect(percentSchema('Rate').parse(18)).toBe(1800);
    expect(percentSchema('Rate').parse(12.5)).toBe(1250);
  });

  it('explains a weak password rule by rule, and a missing or mistyped one plainly', () => {
    expect(say(passwordSchema, 'short')).toBe('Password needs: more than 8 characters, an uppercase letter, a special character');
    expect(say(passwordSchema, undefined)).toBe('Password is required');
    expect(say(passwordSchema, 7)).toBe('Password must be text');
    expect(say(passwordSchema, 'Str0ng#Passw0rd')).toBe('OK');
  });

  it('names the choices when a payment method is missing or unknown', () => {
    const methods = `Method must be one of: ${METHODS.join(', ')}`;
    expect(say(recordPaymentSchema, { amount: 5, method: 'bitcoin' })).toBe(methods);
    expect(say(recordPaymentSchema, { amount: 5 })).toBe(methods);
    expect(say(recordPaymentSchema, { amount: 0, method: 'cash' })).toBe('Amount must be greater than zero');
    expect(say(recordPaymentSchema, { amount: 5, method: 'cash', requestId: 'abc' })).toBe('Request id is too short');
    expect(say(recordPaymentSchema, { amount: 5, method: 'cash', paidOn: '2026-10-01', requestId: 'req-12345678', note: null })).toBe('OK');
  });
});

describe('query strings and defaults', () => {
  it('fills in page and page size, and reads them from text', () => {
    expect(pagingSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(pagingSchema.parse({ page: '3', pageSize: '50' })).toEqual({ page: 3, pageSize: 50 });
  });

  it('refuses a page size above the limit, a page below one, and text that is not a number', () => {
    expect(say(pagingSchema, { pageSize: '500' })).not.toBe('OK');
    expect(say(pagingSchema, { page: '0' })).not.toBe('OK');
    expect(say(pagingSchema, { page: 'abc' })).not.toBe('OK');
  });

  it('applies a default only when the value is absent, not when it is wrong', () => {
    const schema = z.object({ enabled: z.boolean(kind('enabled must be true or false')).default(false) });
    expect(schema.parse({})).toEqual({ enabled: false });
    expect(schema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(say(schema, { enabled: 'yes' })).toBe('enabled must be true or false');
  });
});

describe('parse', () => {
  it('reports the first problem for each field, keyed by field, as a 422', () => {
    const schema = z.object({ amount: moneySchema('Amount'), when: dateSchema('Date') });
    try {
      parse(schema, { amount: -5, when: 'tomorrow' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(422);
      expect(e.fields).toEqual({ amount: 'Amount cannot be negative', when: 'Date must be a date (YYYY-MM-DD)' });
    }
  });

  it('keys a problem inside a list by its position', () => {
    const schema = z.object({ lines: z.array(z.object({ quantity: z.number(kind('Quantity must be a number', 'Quantity is required')) })) });
    try {
      parse(schema, { lines: [{ quantity: 1 }, {}] });
      expect.unreachable();
    } catch (err) {
      expect((err as HttpError).fields).toEqual({ 'lines.1.quantity': 'Quantity is required' });
    }
  });
});
