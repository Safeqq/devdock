// Line icons drawn on a 24px grid, matching the D3 mockups. Decorative unless a label is given.
const paths = {
  play: <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />,
  redo: (
    <path
      d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  open: (
    <path
      d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />,
  folder: (
    <path
      d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9S14.6 18.4 12 21M12 3C9.4 5.6 8.2 8.6 8.2 12s1.2 6.4 3.8 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </>
  ),
  check: (
    <path
      d="M5 12.5l4.5 4.5L19 7.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  x: (
    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  ),
  alert: (
    <>
      <path
        d="M12 3.5l9.5 16.5h-19z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M12 10v4.5M12 17.2v.3"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </>
  ),
  layers: (
    <path
      d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  ),
  terminal: (
    <>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.6v.3M12 16.8v.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="19" cy="12" r="1.8" fill="currentColor" />
    </>
  ),
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="currentColor" />,
  copy: (
    <>
      <rect
        x="8"
        y="8"
        width="12"
        height="12"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </>
  ),
  download: (
    <path
      d="M12 4v11M7 10.5l5 5 5-5M5 20h14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  trash: (
    <path
      d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className === undefined ? "icon" : `icon ${className}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

// The DevDock mark: three dock bars, as in the app icon.
export function Logo({ big = false }: { big?: boolean }) {
  return (
    <span className={big ? "logo big" : "logo"} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
