import { HttpError } from './http.js';

/**
 * The subscription lifecycle as data, so the same rules drive the API's checks and the buttons the
 * screens offer.
 *
 *   Draft -> Quotation -> Confirmed -> Active -> Closed
 *
 * with Paused (Active <-> Paused), early closure, renewal and automatic closure at expiry as the
 * extras a plan may permit. Every rule is enforced by the backend; the UI only reflects it.
 */

export const STATUSES = ['draft', 'quotation', 'confirmed', 'active', 'paused', 'closed'] as const;
export type Status = (typeof STATUSES)[number];

export const ACTIONS = ['send_quote', 'revert_to_draft', 'confirm', 'activate', 'pause', 'resume', 'close', 'cancel', 'renew'] as const;
export type Action = (typeof ACTIONS)[number];

export interface PlanRules {
  allowPause: boolean;
  allowEarlyClose: boolean;
  allowRenewal: boolean;
}

/** Staff means an admin or a staff member. */
export type Actor = 'staff' | 'customer';

interface Rule {
  from: Status[];
  /** Resulting status; renewal keeps the status. */
  to: Status | 'same';
  label: string;
  /** Said when the subscription is in the wrong state. */
  onlyWhen: string;
  actors: Actor[];
  /** Plan setting that must be on, if any, and what to say when it is off. */
  needs?: { setting: keyof PlanRules; message: string };
}

export const RULES: Record<Action, Rule> = {
  send_quote: { from: ['draft'], to: 'quotation', label: 'Send quotation', onlyWhen: 'Only a draft can be sent as a quotation', actors: ['staff'] },
  revert_to_draft: { from: ['quotation'], to: 'draft', label: 'Back to draft', onlyWhen: 'Only a quotation can go back to draft', actors: ['staff'] },
  confirm: { from: ['quotation'], to: 'confirmed', label: 'Confirm', onlyWhen: 'Only a quotation can be confirmed', actors: ['staff', 'customer'] },
  activate: { from: ['confirmed'], to: 'active', label: 'Activate', onlyWhen: 'Only a confirmed subscription can be activated', actors: ['staff'] },
  pause: { from: ['active'], to: 'paused', label: 'Pause', onlyWhen: 'Only an active subscription can be paused', actors: ['staff', 'customer'], needs: { setting: 'allowPause', message: 'This plan does not allow pausing.' } },
  resume: { from: ['paused'], to: 'active', label: 'Resume', onlyWhen: 'Only a paused subscription can be resumed', actors: ['staff', 'customer'], needs: { setting: 'allowPause', message: 'This plan does not allow pausing.' } },
  close: { from: ['active', 'paused'], to: 'closed', label: 'Close early', onlyWhen: 'Only an active or paused subscription can be closed early', actors: ['staff', 'customer'], needs: { setting: 'allowEarlyClose', message: 'This plan cannot be closed before its expiry date.' } },
  cancel: { from: ['draft', 'quotation', 'confirmed'], to: 'closed', label: 'Cancel', onlyWhen: 'Only a draft, quotation or confirmed subscription can be cancelled', actors: ['staff'] },
  renew: { from: ['active', 'paused'], to: 'same', label: 'Renew', onlyWhen: 'Only an active or paused subscription can be renewed', actors: ['staff', 'customer'], needs: { setting: 'allowRenewal', message: 'This plan does not allow renewal.' } },
};

/** The actions this actor can take right now. */
export function availableActions(status: Status, plan: PlanRules, actor: Actor): { action: Action; label: string }[] {
  return ACTIONS.filter((a) => {
    const r = RULES[a];
    return r.from.includes(status) && r.actors.includes(actor) && (!r.needs || plan[r.needs.setting]);
  }).map((a) => ({ action: a, label: RULES[a].label }));
}

/** Throws the right HTTP error when `action` is not allowed; returns the status that results. */
export function checkTransition(action: Action, status: Status, plan: PlanRules, actor: Actor): Status {
  const rule = RULES[action];
  if (!rule.actors.includes(actor)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  if (!rule.from.includes(status)) throw new HttpError(409, 'invalid_transition', `${rule.onlyWhen}; this one is ${status}.`);
  if (rule.needs && !plan[rule.needs.setting]) throw new HttpError(409, 'not_allowed_by_plan', rule.needs.message);
  return rule.to === 'same' ? status : rule.to;
}
