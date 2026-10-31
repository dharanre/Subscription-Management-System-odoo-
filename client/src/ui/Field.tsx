import { AlertCircle, Check, Eye, EyeOff } from 'lucide-react';
import { type InputHTMLAttributes, useId, useState } from 'react';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onChange(value: string): void;
  error?: string;
  hint?: string;
}

export function TextField({ label, value, onChange, error, hint, type = 'text', id, ...rest }: TextFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const [shown, setShown] = useState(false);
  const isPassword = type === 'password';
  const describedBy = [error && `${inputId}-err`, hint && `${inputId}-hint`].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="field__control">
        <input
          {...rest}
          id={inputId}
          className={`input${isPassword ? ' input--with-action' : ''}`}
          type={isPassword && shown ? 'text' : type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        {isPassword && (
          <button type="button" className="field__action" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'}>
            {shown ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </div>
      {error && (
        <p className="field__error" id={`${inputId}-err`} role="alert">
          <AlertCircle size={15} style={{ flex: 'none', marginTop: 2 }} />
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="field__hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

interface ControlProps {
  label: string;
  error?: string;
  hint?: string;
  id?: string;
}

function FieldShell({ label, error, hint, inputId, children }: ControlProps & { inputId: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      {children}
      {error && (
        <p className="field__error" id={`${inputId}-err`} role="alert">
          <AlertCircle size={15} style={{ flex: 'none', marginTop: 2 }} />
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="field__hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

const describe = (id: string, error?: string, hint?: string) => [error && `${id}-err`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;

export function SelectField({
  label,
  value,
  onChange,
  error,
  hint,
  id,
  children,
  ...rest
}: ControlProps & { value: string; onChange(v: string): void; children: React.ReactNode } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <FieldShell label={label} error={error} hint={hint} inputId={inputId}>
      <select {...rest} id={inputId} className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={describe(inputId, error, hint)}>
        {children}
      </select>
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  error,
  hint,
  id,
  ...rest
}: ControlProps & { value: string; onChange(v: string): void } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <FieldShell label={label} error={error} hint={hint} inputId={inputId}>
      <textarea {...rest} id={inputId} className="input textarea" rows={3} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={describe(inputId, error, hint)} />
    </FieldShell>
  );
}

/** A text input with a currency/unit prefix or suffix, for amounts and percentages. */
export function AffixField({
  label,
  value,
  onChange,
  error,
  hint,
  id,
  prefix,
  suffix,
  ...rest
}: ControlProps & { value: string; onChange(v: string): void; prefix?: string; suffix?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'prefix'>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <FieldShell label={label} error={error} hint={hint} inputId={inputId}>
      <div className="affix" data-invalid={error ? true : undefined}>
        {prefix && <span className="affix__text">{prefix}</span>}
        <input {...rest} id={inputId} className="affix__input" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={describe(inputId, error, hint)} />
        {suffix && <span className="affix__text">{suffix}</span>}
      </div>
    </FieldShell>
  );
}

export function CheckboxField({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  const id = useId();
  return (
    <label className="check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="check__label">{label}</span>
        {hint && <span className="check__hint">{hint}</span>}
      </span>
    </label>
  );
}

/** Mirrors the server's password rules so people see what is missing while typing. The server stays authoritative. */
export const PASSWORD_RULES = [
  { id: 'length', label: 'More than 8 characters', test: (p: string) => p.length > 8 },
  { id: 'upper', label: 'Uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'Lowercase letter', test: (p: string) => /[a-z]/.test(p) },
  { id: 'special', label: 'Special character', test: (p: string) => /[^A-Za-z0-9\s]/.test(p) },
];

export const passwordIsValid = (p: string) => PASSWORD_RULES.every((r) => r.test(p));

export function PasswordRules({ value }: { value: string }) {
  return (
    <ul className="rules" aria-label="Password requirements">
      {PASSWORD_RULES.map((r) => {
        const met = r.test(value);
        return (
          <li key={r.id} data-met={met}>
            <span className="dot" aria-hidden="true">
              {met && <Check size={10} strokeWidth={3.5} />}
            </span>
            {r.label}
            <span className="sr-only">{met ? ' (met)' : ' (not met yet)'}</span>
          </li>
        );
      })}
    </ul>
  );
}
