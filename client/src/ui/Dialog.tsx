import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from './Button';

interface DialogProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/** Built on the native <dialog> element, which provides focus trapping, Escape-to-close and a backdrop. */
export function Dialog({ open, title, onClose, children, footer, wide }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog--wide' : ''}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="dialog__head">
            <h2 id={titleId}>{title}</h2>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog" icon={<X size={18} />} />
          </div>
          {children}
          {footer && <div className="dialog__foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onClose(): void;
  children: ReactNode;
}

export function ConfirmDialog({ open, title, confirmLabel, danger, busy, onConfirm, onClose, children }: ConfirmProps) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="dialog__body">{children}</div>
    </Dialog>
  );
}
