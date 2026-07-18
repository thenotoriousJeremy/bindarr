export default function Logo({ style, className }) {
  return (
    <svg 
      viewBox="0 0 40 40" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg" 
      role="img" 
      aria-label="Bindarr logo"
      className={className}
      style={{ width: '100%', height: '100%', ...style }}
    >
      <rect x="4" y="9" width="32" height="24" rx="2.5" fill="var(--logo-cover, #ff4747)" stroke="var(--logo-ring-stroke, #111)" strokeWidth="1.6"/>
      <rect x="7" y="12" width="10" height="18" rx="1.5" fill="var(--logo-page-left, #ffd0d0)" stroke="var(--logo-ring-stroke, #111)" strokeWidth="1.2"/>
      <rect x="23" y="12" width="10" height="18" rx="1.5" fill="var(--logo-page-right, #fff)" stroke="var(--logo-ring-stroke, #111)" strokeWidth="1.2"/>
      <rect x="18.5" y="9" width="3" height="24" fill="var(--logo-spine, #c92f2f)" stroke="var(--logo-ring-stroke, #111)" strokeWidth="1"/>
      <path d="M17 16.5 A3 3 0 0 1 23 16.5" fill="none" stroke="var(--logo-ring-stroke, #111)" strokeWidth="2.6" strokeLinecap="round"/>
      <path d="M17 22 A3 3 0 0 1 23 22" fill="none" stroke="var(--logo-ring-stroke, #111)" strokeWidth="2.6" strokeLinecap="round"/>
      <path d="M17 27.5 A3 3 0 0 1 23 27.5" fill="none" stroke="var(--logo-ring-stroke, #111)" strokeWidth="2.6" strokeLinecap="round"/>
      <path d="M17 16.5 A3 3 0 0 1 23 16.5" fill="none" stroke="var(--logo-ring-inner, #fff)" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M17 22 A3 3 0 0 1 23 22" fill="none" stroke="var(--logo-ring-inner, #fff)" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M17 27.5 A3 3 0 0 1 23 27.5" fill="none" stroke="var(--logo-ring-inner, #fff)" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}
