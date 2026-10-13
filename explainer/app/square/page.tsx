import { Player } from '@/components/Player';

export const metadata = { title: 'Spidermonkey · square cut', robots: { index: false } };

/** The square social cut on its own, for previewing and recording. */
export default function SquarePage() {
  return (
    <main className="mx-auto w-full max-w-[42rem] px-5 py-10">
      <Player composition="square" />
    </main>
  );
}
