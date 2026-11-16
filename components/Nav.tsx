'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Search' },
  { href: '/settings', label: 'Settings' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <header className="topbar">
      <Link href="/" className="brand">Contact Finder</Link>
      <nav className="tabs">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={`tab ${path === l.href ? 'active' : ''}`}>
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
