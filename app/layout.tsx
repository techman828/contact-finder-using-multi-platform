import type { Metadata } from 'next';
import Nav from '@/components/Nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Contact Finder',
  description: 'Find emails and phone numbers from a LinkedIn profile URL',
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='11' cy='11' r='7' fill='none' stroke='%232563eb' stroke-width='2.5'/><path d='M16 16l5 5' stroke='%232563eb' stroke-width='2.5' stroke-linecap='round'/></svg>",
  },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
