import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Code, PropsTable, Section, Specimen, SubSection, px, useComputed } from './parts';

export function ActionsContent() {
  return <ButtonSection />;
}

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Array<{ variant: Variant; label: string; use: string }> = [
  { variant: 'primary', label: 'Deposit', use: 'The standard action. Sand, so it never competes with the price.' },
  { variant: 'accent', label: 'Claim rewards', use: 'Reward actions and the opening call to action. One in view at a time.' },
  { variant: 'secondary', label: 'Withdraw', use: 'The other action beside a primary one, or the action that takes value out.' },
  { variant: 'ghost', label: 'Cancel', use: 'Stepping back inside a panel or dialog.' },
  { variant: 'danger', label: 'Remove', use: 'Destructive and irreversible. Outlined, never filled.' },
];

function ButtonSection() {
  return (
    <Section
      id="button"
      title="Button"
      source="src/components/ui/Button.tsx"
      lede="One button in five variants. Sand is the standard action; the sun is kept for reward actions, so a filled amber button always means the same thing."
    >
      <SubSection title="Variants" note="Hover each one. Disabled and loading are shown beside it.">
        <div className="divide-y divide-stroke-weak border-y border-stroke-weak">
          <div className="eyebrow hidden gap-x-6 py-2.5 md:grid md:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
            <span>Variant</span><span>Default</span><span>Disabled</span><span>Loading</span>
          </div>
          {VARIANTS.map((v) => (
            <div key={v.variant} className="grid items-center gap-x-6 gap-y-3.5 py-4 md:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
              <div className="grid gap-1">
                <code className="font-mono text-xs text-strong">{v.variant}</code>
                <p className="max-w-[36ch] text-sm text-weak">{v.use}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 md:contents">
                <div><Button variant={v.variant}>{v.label}</Button></div>
                <div><Button variant={v.variant} disabled>{v.label}</Button></div>
                <div><Button variant={v.variant} loading>{v.label}</Button></div>
              </div>
            </div>
          ))}
        </div>
      </SubSection>

      <SubSection title="Sizes" note="Heights are read off the button. md is the default; sm is for the header and for rows; xs sits inside a panel header.">
        <Specimen align="end" className="gap-x-10">
          {(['xs', 'sm', 'md', 'lg'] as const).map((s) => <SizeSample key={s} size={s} />)}
        </Specimen>
      </SubSection>

      <SubSection title="Full width" note={<><Code>block</Code> fills the container: the action at the foot of a card or sheet.</>}>
        <Specimen surface="elevated" className="!block" code='<Button block>Deposit</Button>'>
          <div className="mx-auto grid max-w-[346px] gap-2.5">
            <Button block>Deposit</Button>
            <Button block variant="secondary">Withdraw</Button>
          </div>
        </Specimen>
      </SubSection>

      <SubSection title="States">
        <div className="divide-y divide-stroke-weak border-y border-stroke-weak text-sm">
          {[
            ['Hover', 'A fill lights up to its hover token; an outline strengthens; a ghost gains fill-hover. 300ms on ease-dusk.'],
            ['Focus', 'The shared 2px outline in stroke-focused. Never removed.'],
            ['Disabled', 'fill-disabled, stroke-strong and text-disabled, with a not-allowed cursor. The button is disabled in the DOM, not only dimmed.'],
            ['Loading', 'Disabled, with the mark as the spinner and the label at 80%. The label stays, so the button keeps its width and its meaning.'],
          ].map(([k, v]) => (
            <div key={k} className="grid gap-x-6 gap-y-0.5 py-2.5 sm:grid-cols-[110px_minmax(0,1fr)]">
              <span className="text-strong">{k}</span>
              <span className="text-weak">{v}</span>
            </div>
          ))}
        </div>
        <LoadingDemo />
      </SubSection>

      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'variant', type: "'primary' | 'accent' | 'secondary' | 'ghost' | 'danger'", def: "'primary'", note: 'Which of the five.' },
            { name: 'size', type: "'xs' | 'sm' | 'md' | 'lg'", def: "'md'", note: 'Height and text size.' },
            { name: 'loading', type: 'boolean', note: 'Shows the spinner and disables the button.' },
            { name: 'block', type: 'boolean', note: 'Fills the width of its container.' },
            { name: '…rest', type: 'ButtonHTMLAttributes', note: 'Passed to the button: onClick, disabled, type, aria-*.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function SizeSample({ size }: { size: 'xs' | 'sm' | 'md' | 'lg' }) {
  const [ref, [height]] = useComputed<HTMLDivElement>(['height']);
  return (
    <div className="grid justify-items-start gap-2.5">
      <div ref={ref}><Button size={size}>Deposit</Button></div>
      <code className="font-mono text-xs text-weaker">{size}{height && ` · ${px(height)}px`}</code>
    </div>
  );
}

function LoadingDemo() {
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    setTimeout(() => setBusy(false), 1800);
  };
  return (
    <Specimen code="<Button loading={busy} onClick={submit}>Deposit</Button>">
      <Button loading={busy} onClick={run}>Deposit</Button>
      <span className="text-xs text-weaker">Press it to see the wait.</span>
    </Specimen>
  );
}
