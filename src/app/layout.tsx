import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'Evokz ACE — AI Creative Engine',
  description:
    'Multi-tenant creative automation: scheduled Flux.1 generation, Google Drive sync, and WhatsApp delivery.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /* No `dark` class here: the body is light, and `.dark` is applied per
       island (the header bar, the brand canvas) instead. */
    <html lang="en">
      <body className={`${inter.variable} font-sans`}>{children}</body>
    </html>
  );
}
