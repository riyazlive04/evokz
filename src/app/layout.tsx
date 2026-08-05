import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'Evokz ACE — AI Creative Engine',
  description:
    'Multi-tenant creative automation: scheduled Flux.1 generation, Google Drive sync, and WhatsApp delivery.',
};

/**
 * Resolves the theme before first paint.
 *
 * Has to run synchronously in <head>: a React effect would run after the first
 * frame, so a dark-mode user would see a white flash on every load. A plain
 * <script> child of <head> is emitted inline in the served HTML, which
 * `next/script` would not guarantee.
 *
 * Absence of the storage key means "follow the OS", so no third 'system'
 * sentinel needs storing. Wrapped in try/catch for Safari private mode.
 */
const THEME_SCRIPT = `(function(){try{
var s=localStorage.getItem('evokz-theme');
var d=s==='dark'||(s!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
var e=document.documentElement;
e.classList.toggle('dark',d);
e.style.colorScheme=d?'dark':'light';
}catch(_){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /* suppressHydrationWarning is required and scoped deliberately to <html>:
       THEME_SCRIPT mutates this element's className and style before React
       hydrates. It covers only this element's own attributes and does not
       cascade, so genuine mismatches further down still surface. */
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={`${inter.variable} font-sans`}>{children}</body>
    </html>
  );
}
