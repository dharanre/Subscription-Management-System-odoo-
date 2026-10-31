import bcrypt from 'bcryptjs';

/** bcrypt only reads the first 72 bytes, so longer passwords are rejected rather than silently truncated. */
const MAX_BYTES = 72;

export const PASSWORD_RULES = [
  { id: 'length', label: 'More than 8 characters', test: (p: string) => p.length > 8 },
  { id: 'upper', label: 'An uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter', test: (p: string) => /[a-z]/.test(p) },
  { id: 'special', label: 'A special character', test: (p: string) => /[^A-Za-z0-9\s]/.test(p) },
] as const;

/** Returns the labels of every unmet rule (empty when the password is acceptable). */
export function passwordProblems(password: string): string[] {
  const problems: string[] = PASSWORD_RULES.filter((r) => !r.test(password)).map((r) => r.label);
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) problems.push(`No more than ${MAX_BYTES} bytes`);
  return problems;
}

export function hashPassword(password: string, cost: number): Promise<string> {
  return bcrypt.hash(password, cost);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Compared against when the email is unknown so response time does not reveal whether an account exists. */
export const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);
