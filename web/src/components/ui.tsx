import type { ButtonHTMLAttributes, ReactNode } from "react";

/* Small shared pieces. Colours come from the semantic tokens in index.css,
 * which flip with prefers-color-scheme, so nothing here writes dark:.
 *
 * Fine print (badges, meta lines, small buttons) is 14px on a phone and
 * only drops to 11–12px from `sm` up: `text-sm sm:text-xs` throughout, so
 * nothing on a phone renders below 14px. Tap heights come from the
 * base-layer rule in index.css, not from classes here. */

export function Card({ children, className = "", ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, string>) {
  return (
    <section className={`rounded-2xl border border-line bg-panel p-4 ${className}`} {...rest}>
      {children}
    </section>
  );
}

type Tone = "neutral" | "accent" | "warn" | "err";
const TONES: Record<Tone, string> = {
  neutral: "bg-raised text-fg-2",
  accent: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn",
  err: "bg-err-soft text-err",
};

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={`inline-flex shrink-0 items-center rounded-full px-2 whitespace-nowrap py-0.5 text-sm leading-none font-semibold sm:text-[11px] ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/* Buttons are game keys: primary and secondary sit on a 3px edge and
 * press down into it; ghost is flat, for quiet actions. */
type Variant = "primary" | "secondary" | "ghost";
const PRESS = "shadow-[0_3px_0_var(--edge)] active:translate-y-[2px] active:shadow-[0_1px_0_var(--edge)] disabled:translate-y-0";
const VARIANTS: Record<Variant, string> = {
  primary: `bg-accent text-accent-ink hover:bg-accent-hover border-transparent [--edge:var(--accent-edge)] ${PRESS}`,
  secondary: `bg-panel text-fg border-line-strong hover:bg-raised [--edge:var(--line-strong)] ${PRESS}`,
  ghost: "bg-transparent text-fg-2 border-transparent hover:bg-raised hover:text-fg",
};

export function Button({
  variant = "secondary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-1.5 font-[family-name:var(--font-display)] text-sm font-medium transition-[background-color,transform,box-shadow] duration-75 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

export const inputClass =
  "w-full rounded-xl border border-line-strong/70 bg-panel px-3 py-1.5 text-sm text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-soft";

/** The folder picker the Go tab's save form and a Library row's "Move to" share. */
export function FolderSelect({
  value,
  folders,
  disabled,
  label,
  onChange,
}: {
  value: string;
  folders: string[];
  disabled?: boolean;
  label: string;
  onChange: (folder: string) => void;
}) {
  return (
    <select aria-label={label} className={`${inputClass} w-auto`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">No folder</option>
      {folders.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
    </select>
  );
}

/** A chevron that rotates open — the Customize tab's row disclosure. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={`size-4 shrink-0 text-fg-3 transition-transform ${open ? "rotate-180" : ""}`}>
      <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
