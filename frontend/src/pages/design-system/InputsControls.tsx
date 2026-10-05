import { useState } from 'react';
import { AmountInput } from '@/components/ui/AmountInput';
import { Segmented, UnderlineTabs } from '@/components/ui/Tabs';
import { Toggle } from '@/components/ui/Toggle';
import { Code, PropsTable, Section, Specimen, SubSection } from './parts';

export function InputsControlsContent() {
  return (
    <>
      <AmountInputSection />
      <ToggleSection />
      <SegmentedSection />
      <UnderlineTabsSection />
      <ChainFilterSection />
      <NativeControlsSection />
    </>
  );
}

const NOT_IN_USE = 'Not used in the app yet';

function AmountInputSection() {
  const [empty, setEmpty] = useState('');
  const [filled, setFilled] = useState('1250');
  const [over, setOver] = useState('9000');
  const balance = 4820.5;
  return (
    <Section
      id="amount-input"
      title="Amount input"
      source="src/components/ui/AmountInput.tsx"
      status={NOT_IN_USE}
      lede="A number, the token it is in, and what there is to spend. The field is a well: it goes back down to night inside a card. The deposit card currently draws its own larger field; this is the compact one."
    >
      <SubSection title="States">
        <div className="grid gap-5 md:grid-cols-3">
          <Specimen surface="elevated" className="!block" code="hint">
            <AmountInput value={empty} onChange={setEmpty} token="USDG" hint="Minimum 10 USDG" />
          </Specimen>
          <Specimen surface="elevated" className="!block" code="balance + onMax">
            <AmountInput value={filled} onChange={setFilled} token="USDG" balance={balance} onMax={() => setFilled(String(balance))} />
          </Specimen>
          <Specimen surface="elevated" className="!block" code="error">
            <AmountInput value={over} onChange={setOver} token="USDG" balance={balance} onMax={() => setOver(String(balance))} error={Number(over) > balance ? 'More than your balance' : null} />
          </Specimen>
        </div>
      </SubSection>

      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'value', type: 'string', note: 'The amount as typed. Kept as a string so "0." survives.' },
            { name: 'onChange', type: '(v: string) => void', note: 'Called with every edit.' },
            { name: 'token', type: 'string', note: 'The unit, shown inside the field.' },
            { name: 'balance', type: 'number', note: 'Shown under the field, right-aligned.' },
            { name: 'balanceLabel', type: 'string', def: "'Balance'", note: 'What the balance is called.' },
            { name: 'onMax', type: '() => void', note: 'Adds the Max button.' },
            { name: 'error', type: 'string | null', note: 'Turns the edge to stroke-error and replaces the hint. Say what is wrong and how much is allowed.' },
            { name: 'hint', type: 'string', note: 'Quiet help under the field.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function ToggleSection() {
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  const [c, setC] = useState(true);
  return (
    <Section
      id="toggle"
      title="Toggle"
      source="src/components/ui/Toggle.tsx"
      status={NOT_IN_USE}
      lede="A setting that takes effect at once. The knob is square-cut like every other control; on is a filled track, off is an empty one."
    >
      <Specimen code='<Toggle checked={on} onChange={setOn} label="Auto-compound" />'>
        <label className="flex items-center gap-3 text-sm text-weak"><Toggle checked={a} onChange={setA} label="Auto-compound" /> Auto-compound</label>
        <label className="flex items-center gap-3 text-sm text-weak"><Toggle checked={b} onChange={setB} label="Show closed vaults" /> Show closed vaults</label>
        <label className="flex items-center gap-3 text-sm text-weak"><Toggle checked={c} onChange={setC} tone="accent" label="Lock rewards" /> Lock rewards <Code>tone="accent"</Code></label>
      </Specimen>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'checked', type: 'boolean', note: 'On or off.' },
            { name: 'onChange', type: '(v: boolean) => void', note: 'Called with the new value.' },
            { name: 'label', type: 'string', note: 'The accessible name. Always pass it; the visible text beside the switch is not linked to it.' },
            { name: 'tone', type: "'primary' | 'accent'", def: "'primary'", note: 'Accent only for a setting about rewards.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function SegmentedSection() {
  const [win, setWin] = useState<'30D' | '7D'>('30D');
  const [mode, setMode] = useState<'single' | 'both' | 'zap'>('single');
  return (
    <Section
      id="segmented"
      title="Segmented"
      source="src/components/ui/Tabs.tsx"
      lede="A choice between a few views of the same thing: a time window, a way to pay. The chosen segment is filled sand; the rest are plain text."
    >
      <Specimen code='<Segmented size="sm" value={win} onChange={setWin} options={[…]} />'>
        <div className="grid justify-items-start gap-2">
          <Segmented size="sm" value={win} onChange={setWin} options={[{ value: '30D', label: '30D' }, { value: '7D', label: '7D' }]} />
          <code className="font-mono text-xs text-weaker">sm</code>
        </div>
        <div className="grid justify-items-start gap-2">
          <Segmented value={mode} onChange={setMode} options={[{ value: 'single', label: 'One token' }, { value: 'both', label: 'Both tokens' }, { value: 'zap', label: 'Zap', disabled: true }]} />
          <code className="font-mono text-xs text-weaker">md, one option disabled</code>
        </div>
      </Specimen>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'value', type: 'T extends string', note: 'The chosen option.' },
            { name: 'onChange', type: '(v: T) => void', note: 'Called with the option picked.' },
            { name: 'options', type: 'Array<{ value: T; label: string; disabled?: boolean }>', note: 'Two to four. More than that is a menu.' },
            { name: 'size', type: "'sm' | 'md'", def: "'md'", note: 'sm sits beside a chart title.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function UnderlineTabsSection() {
  const [tab, setTab] = useState<'overview' | 'history' | 'parameters'>('overview');
  return (
    <Section
      id="underline-tabs"
      title="Underline tabs"
      source="src/components/ui/Tabs.tsx"
      status={NOT_IN_USE}
      lede="Sections of one page. The chosen tab is underlined in stroke-selected on the rule the tabs share."
    >
      <Specimen className="!block" code="<UnderlineTabs value={tab} onChange={setTab} options={[…]} />">
        <UnderlineTabs value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'history', label: 'Rebalance history' }, { value: 'parameters', label: 'Parameters' }]} />
      </Specimen>
      <p className="max-w-[64ch] text-sm text-weak">Takes the same props as Segmented, without <Code>size</Code>.</p>
    </Section>
  );
}

function ChainFilterSection() {
  return (
    <Section
      id="chain-filter"
      title="Chain filter"
      source="src/components/ui/ChainFilter.tsx"
      lede="A row of text tabs for the network, the chosen one underlined. With one chain there is nothing to choose, so it draws nothing: that is why the Earn page shows no filter today."
    >
      <Specimen code="<ChainFilter value={chain} onChange={setChain} />">
        <span className="text-sm text-weaker">Nothing is drawn while Robinhood Chain is the only network. Add a second chain to the component's list and the filter shows itself.</span>
      </Specimen>
    </Section>
  );
}

function NativeControlsSection() {
  const [pct, setPct] = useState(50);
  const [ack, setAck] = useState(true);
  return (
    <Section
      id="native-controls"
      title="Slider & checkbox"
      source="src/index.css"
      lede="Two native controls, restyled rather than rebuilt, so they keep their keyboard and screen reader behaviour for free."
    >
      <Specimen code={'<input type="range" />   <input type="checkbox" className="accent-fill-accent" />'}>
        <label className="grid w-full max-w-[280px] gap-2.5 text-sm text-weak">
          <span className="flex justify-between"><span>Withdraw</span><span className="num text-strong">{pct}%</span></span>
          <input type="range" min={0} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
        </label>
        <label className="flex items-start gap-2.5 text-sm text-weak">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 accent-fill-accent" />
          I understand that LP positions can lose value.
        </label>
      </Specimen>
    </Section>
  );
}
