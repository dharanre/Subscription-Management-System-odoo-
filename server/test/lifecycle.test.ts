import { describe, expect, it } from 'vitest';
import { ACTIONS, type Action, RULES, STATUSES, type Status, availableActions, checkTransition } from '../src/lib/lifecycle.js';

const ALL = { allowPause: true, allowEarlyClose: true, allowRenewal: true };
const NONE = { allowPause: false, allowEarlyClose: false, allowRenewal: false };

/** The lifecycle written out by hand, independently of the rules table, so a typo in one is caught by the other. */
const EXPECTED: Record<Status, Action[]> = {
  draft: ['send_quote', 'cancel'],
  quotation: ['revert_to_draft', 'confirm', 'cancel'],
  confirmed: ['activate', 'cancel'],
  active: ['pause', 'close', 'renew'],
  paused: ['resume', 'close', 'renew'],
  closed: [],
};

describe('lifecycle rules', () => {
  it.each(STATUSES)('from %s a staff member can do exactly the permitted actions', (status) => {
    const allowed = availableActions(status, ALL, 'staff').map((a) => a.action).sort();
    expect(allowed).toEqual([...EXPECTED[status]].sort());
  });

  it('follows Draft -> Quotation -> Confirmed -> Active -> Closed', () => {
    let status: Status = 'draft';
    for (const action of ['send_quote', 'confirm', 'activate', 'close'] as Action[]) {
      status = checkTransition(action, status, ALL, 'staff');
    }
    expect(status).toBe('closed');
  });

  it('never allows anything once closed, and never skips a step', () => {
    for (const action of ACTIONS) {
      expect(() => checkTransition(action, 'closed', ALL, 'staff'), action).toThrow(/closed/);
    }
    expect(() => checkTransition('activate', 'draft', ALL, 'staff')).toThrow();
    expect(() => checkTransition('confirm', 'draft', ALL, 'staff')).toThrow();
    expect(() => checkTransition('close', 'confirmed', ALL, 'staff')).toThrow();
  });

  it('lets each plan decide whether pausing, early closure and renewal are allowed', () => {
    expect(availableActions('active', NONE, 'staff').map((a) => a.action)).toEqual([]);
    expect(availableActions('active', { ...NONE, allowPause: true }, 'staff').map((a) => a.action)).toEqual(['pause']);
    expect(availableActions('active', { ...NONE, allowEarlyClose: true }, 'staff').map((a) => a.action)).toEqual(['close']);
    expect(availableActions('active', { ...NONE, allowRenewal: true }, 'staff').map((a) => a.action)).toEqual(['renew']);
    expect(() => checkTransition('pause', 'active', NONE, 'staff')).toThrowError(/does not allow pausing/);
    expect(() => checkTransition('close', 'active', NONE, 'staff')).toThrowError(/cannot be closed before/);
    expect(() => checkTransition('renew', 'active', NONE, 'staff')).toThrowError(/does not allow renewal/);
  });

  it('keeps the commercial steps for staff and gives customers only what a plan lets them manage', () => {
    expect(availableActions('quotation', ALL, 'customer').map((a) => a.action)).toEqual(['confirm']);
    expect(availableActions('draft', ALL, 'customer')).toEqual([]);
    expect(availableActions('confirmed', ALL, 'customer')).toEqual([]);
    expect(availableActions('active', ALL, 'customer').map((a) => a.action).sort()).toEqual(['close', 'pause', 'renew']);
    for (const action of ['send_quote', 'revert_to_draft', 'activate', 'cancel'] as Action[]) {
      expect(RULES[action].actors, action).toEqual(['staff']);
    }
  });

  it('reports a permission problem as 403 and a state or plan problem as 409', () => {
    const statusOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { status: number }).status;
      }
      return 200;
    };
    expect(statusOf(() => checkTransition('activate', 'confirmed', ALL, 'customer'))).toBe(403);
    expect(statusOf(() => checkTransition('activate', 'draft', ALL, 'staff'))).toBe(409);
    expect(statusOf(() => checkTransition('pause', 'active', NONE, 'staff'))).toBe(409);
    expect(statusOf(() => checkTransition('pause', 'active', ALL, 'staff'))).toBe(200);
  });

  it('renewal keeps the status', () => {
    expect(checkTransition('renew', 'active', ALL, 'staff')).toBe('active');
    expect(checkTransition('renew', 'paused', ALL, 'staff')).toBe('paused');
  });
});
