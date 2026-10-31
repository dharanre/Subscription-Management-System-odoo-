import { z } from 'zod';
import { kind } from './http.js';

/** Largest amount accepted anywhere, in major units. Keeps products of quantity x price far below 2^53. */
export const MAX_MAJOR = 100_000_000;

/** Exact integer division rounding half up. Only for non-negative operands. */
export function roundDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

const hasAtMost2Decimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-7;

export const toMinor = (major: number) => Math.round(major * 100);
export const fromMinor = (minor: number) => minor / 100;

/** A money amount in major units with at most 2 decimals; parsed to integer minor units. */
export const moneySchema = (label: string) =>
  z
    .number(kind(`${label} must be a number`, `${label} is required`))
    .finite(`${label} must be a number`)
    .min(0, `${label} cannot be negative`)
    .max(MAX_MAJOR, `${label} is too large`)
    .refine(hasAtMost2Decimals, `${label} can have at most 2 decimal places`)
    .transform(toMinor);

/** A percentage 0-100 with at most 2 decimals; parsed to integer basis points. */
export const percentSchema = (label: string) =>
  z
    .number(kind(`${label} must be a number`, `${label} is required`))
    .finite(`${label} must be a number`)
    .min(0, `${label} cannot be negative`)
    .max(100, `${label} cannot exceed 100`)
    .refine(hasAtMost2Decimals, `${label} can have at most 2 decimal places`)
    .transform((n) => Math.round(n * 100));

export const bpToPercent = (bp: number) => bp / 100;

/** A calendar date 'YYYY-MM-DD' that really exists (rejects 2026-02-30). */
export const dateSchema = (label: string) =>
  z
    .string(kind(`${label} must be a date`, `${label} is required`))
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date (YYYY-MM-DD)`)
    .refine((s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, `${label} is not a real calendar date`);

export const today = () => new Date().toISOString().slice(0, 10);
