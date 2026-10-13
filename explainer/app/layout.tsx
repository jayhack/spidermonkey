import type { Metadata, Viewport } from 'next';
import { Syncopate } from 'next/font/google';
import './globals.css';

// The wordmark's face, self-hosted by next/font and exposed to the canvas as --font-logo.
const logo = Syncopate({ weight: '700', subsets: ['latin'], variable: '--font-logo', display: 'block' });

export const metadata: Metadata = {
  title: 'Spidermonkey · an always-on System 1 for coding agents',
  description: 'How a cheap, always-on perceptual system watches the machine and tells a coding agent what deserves its attention.',
};

export const viewport: Viewport = { themeColor: '#000000' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={logo.variable}>
      <body className="bg-wave-ink text-neutral-200 antialiased">{children}</body>
    </html>
  );
}
