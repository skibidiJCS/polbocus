/** polbocus mark: "pbc" drawn as three monoline letters sharing one bowl. */
export function LogoMark({ height = 26 }: { height?: number }) {
  return (
    <svg viewBox="0 0 40 24" height={height} width={(height * 40) / 24} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M3 8v14" />
      <circle cx="7.5" cy="12.5" r="4.5" />
      <path d="M16 3v14" />
      <circle cx="20.5" cy="12.5" r="4.5" />
      <path d="M36.68 9.32A4.5 4.5 0 1 0 36.68 15.68" stroke="var(--accent)" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="sr-only">polbocus</span>
    </span>
  );
}
