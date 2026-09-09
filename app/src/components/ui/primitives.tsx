import { Children, Fragment, cloneElement, createContext, forwardRef, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactElement, type ReactNode, type TextareaHTMLAttributes } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, LoaderCircle, MoreHorizontal, X } from 'lucide-react';
import { Link } from 'react-router';
import { label as formatLabel } from '../../lib/format';
import { SkeletonText, PaginationSkeleton } from './skeleton';

const cx = (...values: (string | false | null | undefined)[]) => values.filter(Boolean).join(' ');
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; loading?: boolean };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, disabled, className, children, type = 'button', ...props }, ref) {
  return <button {...props} ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, className)}>{loading && <LoaderCircle className="ui-spinner" size={14} aria-hidden="true" />}{children}</button>;
});
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton({ label, className, variant = 'ghost', loading, children, ...props }, ref) {
  return <Button {...props} ref={ref} variant={variant} loading={loading} aria-label={label} title={label} className={cx('ui-icon-button', className)}>{loading ? null : children}</Button>;
});
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input {...props} ref={ref} className={cx('ui-input', className)} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea {...props} ref={ref} className={cx('ui-input', 'ui-textarea', className)} />;
});
export function Field({ label, htmlFor, error, hint, children }: { label: ReactNode; htmlFor?: string; error?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const generatedId = useId();
  const onlyChild = Children.count(children) === 1 && isValidElement(children) && children.type !== Fragment && !(typeof children.type === 'string' && ['div', 'span', 'section'].includes(children.type)) ? children as ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }> : null;
  const id = htmlFor ?? onlyChild?.props.id ?? generatedId;
  const descriptionId = `${id}-description`;
  return <div className="ui-field"><label className="ui-field__label" htmlFor={id}>{label}</label>{onlyChild ? cloneElement(onlyChild, { id, 'aria-invalid': error ? true : onlyChild.props['aria-invalid'], 'aria-describedby': [onlyChild.props['aria-describedby'], error || hint ? descriptionId : null].filter(Boolean).join(' ') || undefined }) : children}{(error || hint) && <div id={descriptionId} className={cx('ui-field__hint', Boolean(error) && 'ui-field__error')} role={error ? 'alert' : undefined}>{error || hint}</div>}</div>;
}
export type SelectProps = { value: string; onValueChange: (value: string) => void; options: { value: string; label: string; disabled?: boolean }[]; placeholder?: string; id?: string; name?: string; disabled?: boolean; required?: boolean; 'aria-label'?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; className?: string };
export function Select({ value, onValueChange, options, placeholder = 'Select…', id, name, disabled, required, className, ...aria }: SelectProps) {
  const emptyValue = useId();
  const hasEmptyOption = options.some(option => option.value === '');
  return <SelectPrimitive.Root value={value === '' && hasEmptyOption ? emptyValue : value} onValueChange={next => onValueChange(next === emptyValue ? '' : next)} name={name} disabled={disabled} required={required}><SelectPrimitive.Trigger {...aria} id={id} className={cx('ui-input', 'ui-select-trigger', className)}><SelectPrimitive.Value placeholder={placeholder} /><SelectPrimitive.Icon><ChevronDown size={14} aria-hidden="true" /></SelectPrimitive.Icon></SelectPrimitive.Trigger><SelectPrimitive.Portal><SelectPrimitive.Content className="ui-popover ui-select-content" position="popper" sideOffset={4}><SelectPrimitive.ScrollUpButton className="ui-select-scroll"><ChevronDown size={14} className="ui-rotate" /></SelectPrimitive.ScrollUpButton><SelectPrimitive.Viewport>{options.map(option => <SelectPrimitive.Item key={option.value} value={option.value === '' ? emptyValue : option.value} disabled={option.disabled} className="ui-select-item"><SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>)}</SelectPrimitive.Viewport><SelectPrimitive.ScrollDownButton className="ui-select-scroll"><ChevronDown size={14} /></SelectPrimitive.ScrollDownButton></SelectPrimitive.Content></SelectPrimitive.Portal></SelectPrimitive.Root>;
}
type CheckProps = { checked: boolean; onCheckedChange: (checked: boolean) => void; label: ReactNode; disabled?: boolean; id?: string; name?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };
export function Checkbox({ checked, onCheckedChange, label, disabled, id: suppliedId, ...props }: CheckProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return <div className="ui-check-field"><CheckboxPrimitive.Root {...props} id={id} checked={checked} onCheckedChange={value => onCheckedChange(value === true)} disabled={disabled} className="ui-checkbox"><CheckboxPrimitive.Indicator><Check size={12} strokeWidth={2} /></CheckboxPrimitive.Indicator></CheckboxPrimitive.Root><label htmlFor={id}>{label}</label></div>;
}
export function Switch({ checked, onCheckedChange, label, disabled, id: suppliedId, ...props }: CheckProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return <div className="ui-check-field"><SwitchPrimitive.Root {...props} id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="ui-switch"><SwitchPrimitive.Thumb className="ui-switch__thumb" /></SwitchPrimitive.Root><label htmlFor={id}>{label}</label></div>;
}
export function Tabs({ value, onValueChange, items, label = 'Sections', disabled = false }: { value: string; onValueChange: (value: string) => void | boolean | Promise<void | boolean>; items: { value: string; label: string; count?: number }[]; label?: string; disabled?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const activating = useRef(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  useEffect(() => {
    if (disabled || focusTarget === null || value !== focusTarget) return;
    const tab = refs.current[items.findIndex(item => item.value === focusTarget)];
    if (tab && (tab.parentElement?.contains(document.activeElement) || document.activeElement === document.body)) tab.focus();
    setFocusTarget(null);
  }, [disabled, focusTarget, items, value]);
  async function activate(index: number) {
    if (disabled || activating.current) return;
    activating.current = true;
    try {
      const accepted = await onValueChange(items[index].value);
      // Restore focus after React commits both the selected mode and the enabled controls.
      setFocusTarget(accepted === false ? value : items[index].value);
    } finally { activating.current = false; }
  }
  return <div className="ui-tabs" role="tablist" aria-label={label}>{items.map((item, index) => <button key={item.value} ref={node => { refs.current[index] = node; }} type="button" role="tab" disabled={disabled} aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1} className="ui-tab" onClick={() => void activate(index)} onKeyDown={event => { const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null; if (next !== null) { event.preventDefault(); void activate(next); } }}>{item.label}{item.count !== undefined && <span className="ui-tab__count">{item.count.toLocaleString()}</span>}</button>)}</div>;
}
export type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string };
export function Dialog({ open, onOpenChange, title, description, children, footer, className }: DialogProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const descriptionId = useId();
  // Native input autofocus can precede Radix's callback; retain the external opener, not the mounted input.
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="ui-dialog-overlay" /><DialogPrimitive.Content className={cx('ui-dialog', className)} aria-describedby={description ? descriptionId : undefined} onFocusCapture={event => { const previous = event.relatedTarget; if (previous instanceof HTMLElement && previous !== document.body && !event.currentTarget.contains(previous)) returnFocus.current = previous; }} onOpenAutoFocus={event => { const focused = document.activeElement; const dialog = event.target; if (focused instanceof HTMLElement && (!(dialog instanceof HTMLElement) || !dialog.contains(focused))) returnFocus.current = focused; }} onCloseAutoFocus={event => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }}><div className="ui-dialog__header"><DialogPrimitive.Title className="ui-dialog__title">{title}</DialogPrimitive.Title><DialogPrimitive.Close asChild><IconButton label="Close dialog"><X size={16} /></IconButton></DialogPrimitive.Close></div>{description && <DialogPrimitive.Description id={descriptionId} className="ui-dialog__description">{description}</DialogPrimitive.Description>}<div className="ui-dialog__body">{children}</div>{footer && <div className="ui-dialog__footer">{footer}</div>}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;
}
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', onConfirm, pending, danger = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; confirmLabel?: string; onConfirm: () => void | Promise<unknown>; pending?: boolean; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setError(null); }, [open]);
  const working = pending || busy;
  async function confirm() { setBusy(true); setError(null); try { await onConfirm(); onOpenChange(false); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The action could not be completed. Try again.'); } finally { setBusy(false); } }
  return <Dialog open={open} onOpenChange={next => { if (!working) onOpenChange(next); }} title={title} description={description} footer={<><Button disabled={working} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={working} onClick={confirm}>{confirmLabel}</Button></>}>{error ? <Alert tone="danger">{error}</Alert> : null}</Dialog>;
}
export function DropdownMenu({ items, label = 'More actions', trigger }: { items: { label: string; onSelect: () => void; icon?: ReactNode; destructive?: boolean; disabled?: boolean }[]; label?: string; trigger?: ReactNode }) {
  return <DropdownPrimitive.Root><DropdownPrimitive.Trigger asChild>{trigger ?? <IconButton label={label}><MoreHorizontal size={16} /></IconButton>}</DropdownPrimitive.Trigger><DropdownPrimitive.Portal><DropdownPrimitive.Content align="end" sideOffset={4} className="ui-popover ui-menu">{items.map((item, index) => <DropdownPrimitive.Item key={`${item.label}-${index}`} onSelect={item.onSelect} disabled={item.disabled} className={cx('ui-menu-item', item.destructive && 'ui-menu-item--danger')}><span className="ui-menu-icon">{item.icon}</span>{item.label}</DropdownPrimitive.Item>)}</DropdownPrimitive.Content></DropdownPrimitive.Portal></DropdownPrimitive.Root>;
}
export type Column<T> = { key: string; label: ReactNode; render: (row: T) => ReactNode; width?: string | number; align?: 'left' | 'right'; skeleton?: ReactNode };
export type SkeletonColumn = Pick<Column<never>, 'key' | 'label' | 'width' | 'align' | 'skeleton'>;
export function DataTable<T>({ columns, rows, rowKey, onRowClick, selectedId, empty, loading = false, skeletonRows = 5, minRows = 0 }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void; selectedId?: string; empty?: ReactNode; loading?: boolean; skeletonRows?: number; minRows?: number }) {
  return <div className="ui-table-scroll" aria-busy={loading || undefined}>
    {loading && <span className="sr-only" role="status">Loading table</span>}
    <table className="ui-table"><thead><tr>{columns.map(column => <th scope="col" key={column.key} style={{ width: column.width, textAlign: column.align }}>{column.label}</th>)}</tr></thead>
      <tbody>{loading ? Array.from({ length: skeletonRows }, (_, index) => <tr key={index} aria-hidden="true">{columns.map((column, columnIndex) => <td key={column.key} data-skeleton-align={column.align}>{column.skeleton ?? <SkeletonText width={columnIndex === 0 ? '72%' : '58%'} />}</td>)}</tr>) : rows.map(row => { const id = rowKey(row); return <tr key={id} data-selected={selectedId === id || undefined} className={onRowClick ? 'ui-table__clickable' : undefined} tabIndex={onRowClick ? 0 : undefined} onClick={event => { if (onRowClick && !(event.target as HTMLElement).closest('button, a, input, [role="checkbox"], [role="switch"]')) onRowClick(row); }} onKeyDown={event => { if (onRowClick && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onRowClick(row); } }}>{columns.map(column => <td key={column.key} style={{ textAlign: column.align }}>{column.render(row)}</td>)}</tr>; })}
        {!loading && rows.length > 0 && rows.length < minRows && <tr className="ui-table-spacer" aria-hidden="true"><td colSpan={columns.length} style={{ height: `calc(${minRows - rows.length} * var(--table-row-height))` }} /></tr>}
      </tbody></table>
    {!loading && rows.length === 0 && <div className="ui-table-empty" style={{ minHeight: `calc(${minRows} * var(--table-row-height))` }}>{empty ?? <EmptyState title="No results" />}</div>}
  </div>;
}
export function TableSkeleton({ columns, rows = 5, pagination = false }: { columns: SkeletonColumn[]; rows?: number; pagination?: boolean }) {
  return <><DataTable columns={columns.map(column => ({ ...column, render: () => null }))} rows={[]} rowKey={() => ''} loading skeletonRows={rows} />{pagination && <PaginationSkeleton />}</>;
}
export function Pagination({ page, pageSize, total, nextCursor, onPageChange }: { page: number; pageSize: number; total?: number; nextCursor?: string | null; onPageChange: (page: number) => void }) {
  if (total === undefined) return <nav className="ui-pagination" aria-label="Pagination"><span className="muted">Cursor page {page}</span><div className="cluster"><IconButton variant="secondary" label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={14} /></IconButton><IconButton variant="secondary" label="Next page" disabled={!nextCursor} onClick={() => onPageChange(page + 1)}><ChevronRight size={14} /></IconButton></div></nav>;
  return <NumberedPagination page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} />
}
function NumberedPagination({ page, pageSize, total, onPageChange }: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const validPage = Math.min(pages, Math.max(1, page));
  useEffect(() => { if (page !== validPage) onPageChange(validPage); }, [page, validPage, onPageChange]);
  if (page !== validPage) return <nav className="ui-pagination" aria-label="Pagination"><span className="muted" role="status">Updating page…</span></nav>;
  return <nav className="ui-pagination" aria-label="Pagination"><span className="muted">{total === 0 ? '0 results' : `${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()} of ${total.toLocaleString()}`}</span><div className="cluster"><IconButton variant="secondary" label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={14} /></IconButton><span aria-live="polite">{page} / {pages}</span><IconButton variant="secondary" label="Next page" disabled={page >= pages} onClick={() => onPageChange(page + 1)}><ChevronRight size={14} /></IconButton></div></nav>;
}
export function PageHeader({ title, actions, backTo }: { title: ReactNode; actions?: ReactNode; backTo?: string }) {
  return <header className="ui-page-header"><div className="cluster">{backTo && <Link className="ui-button ui-button--secondary ui-icon-button" to={backTo} aria-label="Go back"><ArrowLeft size={16} /></Link>}<h1>{title}</h1></div>{actions && <div className="cluster">{actions}</div>}</header>;
}
export function SectionHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return <div className="ui-section-header"><h2>{title}</h2>{actions && <div className="cluster">{actions}</div>}</div>;
}
function statusTone(status: string): Tone {
  const value = status.trim().toLowerCase().replaceAll(' ', '_');
  if (['delivered', 'sent', 'active', 'verified', 'enabled', 'subscribed', 'healthy', 'connected', 'completed', 'success', 'production'].includes(value)) return 'success';
  if (['pending', 'scheduled', 'sending', 'queued', 'warning', 'verifying', 'bounced', 'deferred', 'delivery_delayed', 'sandbox', 'probation', 'issue'].includes(value)) return 'warning';
  if (['failed', 'complaint', 'error', 'rejected', 'suppressed', 'shutdown'].includes(value)) return 'danger';
  return 'neutral';
}
export function StatusBadge({ status, tone = statusTone(status) }: { status: string; tone?: Tone }) {
  return <span className={cx('ui-status', `ui-tone--${tone}`)}><span className="ui-status__dot" aria-hidden="true" />{formatLabel(status)}</span>;
}
export function Alert({ tone = 'neutral', title, children, onDismiss }: { tone?: Tone; title?: ReactNode; children: ReactNode; onDismiss?: () => void }) {
  return <div className={cx('ui-alert', `ui-tone--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}><div>{title && <div className="ui-alert__title">{title}</div>}<div>{children}</div></div>{onDismiss && <IconButton label="Dismiss notification" onClick={onDismiss}><X size={14} /></IconButton>}</div>;
}
export function EmptyState({ title, description, action, headingAs: Heading = 'h3' }: { title: string; description?: string; action?: ReactNode; headingAs?: 'h1' | 'h3' }) {
  return <div className="ui-empty-state"><Heading>{title}</Heading>{description && <p className="muted">{description}</p>}{action && <div>{action}</div>}</div>;
}
export function LoadingState({ rows = 5 }: { rows?: number }) {
  return <div className="ui-loading" role="status" aria-label="Loading"><span className="sr-only">Loading…</span>{Array.from({ length: rows }, (_, index) => <div key={index} className="ui-skeleton-row" aria-hidden="true"><span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /></div>)}</div>;
}
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <div className="ui-error-state"><Alert tone="danger" title="Could not load this content">{error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong. Please try again.'}</Alert>{onRetry && <Button onClick={onRetry}>Try again</Button>}</div>;
}
type ToastTone = 'success' | 'error' | 'info';
type ToastFn = (message: string, tone?: ToastTone) => void;
const ToastContext = createContext<ToastFn | null>(null);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string; tone: ToastTone }[]>([]);
  const sequence = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => { clearTimeout(timers.current.get(id)); timers.current.delete(id); setToasts(current => current.filter(toast => toast.id !== id)); }, []);
  const toast = useCallback<ToastFn>((message, tone = 'info') => { const id = ++sequence.current; setToasts(current => [...current.slice(-3), { id, message, tone }]); timers.current.set(id, setTimeout(() => dismiss(id), 6000)); }, [dismiss]);
  useEffect(() => { const current = timers.current; return () => current.forEach(clearTimeout); }, []);
  return <ToastContext.Provider value={toast}>{children}<div className="ui-toasts" aria-label="Notifications">{toasts.map(item => <Alert key={item.id} tone={item.tone === 'error' ? 'danger' : item.tone} onDismiss={() => dismiss(item.id)}>{item.message}</Alert>)}</div></ToastContext.Provider>;
}
export function useToast(): ToastFn {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast must be used inside ToastProvider');
  return toast;
}
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useContext(ToastContext);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <span className="cluster"><IconButton label={copied ? 'Copied' : label} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setError(false); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800); } catch { setError(true); toast?.('Could not copy to clipboard.', 'error'); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton><span className="sr-only" role="status">{copied ? 'Copied to clipboard' : error ? 'Could not copy to clipboard' : ''}</span></span>;
}
