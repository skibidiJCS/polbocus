/** polbocus mark: a viewfinder framing a playhead. */
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="10.75" y="7" width="2.5" height="10" rx="1.25" fill="var(--accent)" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span>polbocus</span>
    </span>
  );
}
