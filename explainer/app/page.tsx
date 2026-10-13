import { Player } from '@/components/Player';

const sections = [
  {
    title: 'A coding agent is all executive function',
    body: 'An agent works one step at a time: read, edit, run, wait. To notice a crashed server or a stuck test, it has to spend its own steps polling for it, and while it is blocked inside a command it perceives nothing. A computer is a busy place, and the agent sees only what its tool results show it.',
  },
  {
    title: 'Two systems',
    body: 'Humans split the work. One system handles executive function: planning, deciding, acting, one thing at a time. Another perceives everything at once, learns what is routine, and makes snap judgments about what deserves attention.',
  },
  {
    title: 'A decision model on top of the machine',
    body: 'Spidermonkey gives the agent that second system. Every two seconds it samples processes, memory, ports, logs and the agent’s own trace. Ordinary code proposes what changed. One call to a small, fast decision model (Jev) judges each change: is it worth attention, and how urgently?',
  },
  {
    title: 'Escalation',
    body: 'What matters reaches the agent in one of three ways. A note rides along on its next tool result. An interrupt stops a command it is stuck on and says why. A wake starts a new turn when something urgent happens after it has finished. Spidermonkey never edits files or stops other programs; it only perceives and reports.',
  },
  {
    title: 'More efficient agentic action',
    body: 'On GPT-6.1 Sol, the interrupt reflex ended hung test runs after about 15 seconds instead of 90, a 54% cut in time on hang tasks, with no false interrupts. In the web-app demo, the decision model cost $0.003 beside $0.20 for the agent.',
  },
];

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-[78rem] px-5 py-10 sm:py-16">
      <header className="max-w-2xl">
        <h1 className="text-3xl font-extrabold tracking-tight text-wave-paper sm:text-4xl">Spidermonkey</h1>
        <p className="mt-3 text-[16.5px] leading-8 text-neutral-400">
          An always-on System 1 for coding agents: cheap perception that watches the machine and tells the agent what deserves its attention.
        </p>
      </header>
      <section className="mt-8">
        <Player responsive />
      </section>
      <article className="mx-auto mt-16 max-w-2xl space-y-10">
        {sections.map(section => (
          <section key={section.title}>
            <h2 className="text-xl font-extrabold tracking-tight text-wave-paper">{section.title}</h2>
            <p className="mt-3 text-[16.5px] leading-8 text-neutral-300">{section.body}</p>
          </section>
        ))}
      </article>
    </main>
  );
}
