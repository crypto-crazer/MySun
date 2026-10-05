import { useState } from 'react';
import { Pill, RangeStatusBadge, TierBadge } from '@/components/ui/Badge';
import { BoostedApr } from '@/components/ui/BoostedApr';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ChainLogo } from '@/components/ui/ChainLogo';
import { Collapsible } from '@/components/ui/Collapsible';
import { DataLegend, DemoBadge, LiveBadge } from '@/components/ui/DataBadge';
import { KV } from '@/components/ui/KeyValue';
import { Stat, StatRow } from '@/components/ui/Stat';
import { TokenIcon, TokenPair } from '@/components/ui/TokenIcon';
import { Code, PropsTable, Section, Specimen, SubSection } from './parts';

export function DataDisplayContent() {
  return (
    <>
      <CardSection />
      <StatSection />
      <StatRowSection />
      <KeyValueSection />
      <BadgesSection />
      <DataBadgesSection />
      <TokenIconSection />
      <ChainLogoSection />
      <BoostedAprSection />
      <CollapsibleSection />
    </>
  );
}

const NOT_IN_USE = 'Not used in the app yet';

function CardSection() {
  return (
    <Section
      id="card"
      title="Card"
      source="src/components/ui/Card.tsx"
      lede="A flat panel one step above the page, edged with a hairline. No shadow. Reach for it when a group of facts needs a boundary; a list of rows usually needs only its dividers."
    >
      <div className="grid items-start gap-5 md:grid-cols-2">
        <Specimen className="!block" code="<Card>…</Card>">
          <Card>
            <p className="text-sm text-weak">Fees compound into the position automatically. There is nothing to claim.</p>
          </Card>
        </Specimen>
        <Specimen className="!block" code='<Card title="Adapters" action={…} padded={false}>'>
          <Card title="Adapters" action={<Button size="sm" variant="ghost">Refresh</Button>} padded={false}>
            <KV className="px-4" rows={[{ k: 'Uniswap v3', v: '$1.82M' }, { k: 'Uniswap v4', v: '$0.61M' }]} />
          </Card>
        </Specimen>
      </div>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'title', type: 'ReactNode', note: 'Adds the header row.' },
            { name: 'action', type: 'ReactNode', note: 'Sits at the right of the header: a quiet button or a tag.' },
            { name: 'padded', type: 'boolean', def: 'true', note: 'False when the content runs to the edges: a table, a list of rows.' },
            { name: '…rest', type: 'HTMLAttributes<HTMLDivElement>', note: 'Passed to the section.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function StatSection() {
  const [clicks, setClicks] = useState(0);
  return (
    <Section
      id="stat"
      title="Stat"
      source="src/components/ui/Stat.tsx"
      lede="A reading and the label that names it. The figure is one weight lighter than a title, so a row of them stays calm. Colour is for meaning: most readings take none."
    >
      <SubSection title="Tones" note="Gain and loss carry their sign in the text as well as the colour.">
        <Specimen align="start" className="gap-x-12">
          <Stat label="TVL" value="$2.4M" />
          <Stat label="PMG rewards" value="18.25 PMG" tone="accent" sub="≈ $36.50" />
          <Stat label="Fees earned" value="+$412.80" tone="success" />
          <Stat label="Period P&L" value="−$96.10" tone="error" />
          <Stat label="Buyback coverage" value="48.0%" tone="warning" />
        </Specimen>
      </SubSection>
      <SubSection title="Sizes and behaviour">
        <Specimen align="start" className="gap-x-12">
          <Stat label="Capacity" value="$2.4M / 3M" />
          <Stat label="Your deposit" value="$12,480.00" size="lg" />
          <Stat label="Pending rewards" value={`${(18.25 + clicks).toFixed(2)} PMG`} tone="accent" sub="Press to add one" onClick={() => setClicks((n) => n + 1)} />
        </Specimen>
      </SubSection>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'label', type: 'ReactNode', note: 'Set as an eyebrow above the value.' },
            { name: 'value', type: 'ReactNode', note: 'The reading. A string, or a component such as BoostedApr.' },
            { name: 'sub', type: 'ReactNode', note: 'A second line: the same amount in another unit.' },
            { name: 'tone', type: "'default' | 'accent' | 'success' | 'error' | 'warning'", def: "'default'", note: 'Accent for reward amounts; the other three for outcomes.' },
            { name: 'size', type: "'md' | 'lg'", def: "'md'", note: 'lg for the one reading a panel is about.' },
            { name: 'onClick', type: '() => void', note: 'Makes the stat a button; the value underlines on hover.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function StatRowSection() {
  return (
    <Section
      id="stat-row"
      title="Stat row"
      source="src/components/ui/Stat.tsx"
      lede="Readings on an engraved scale: each one hangs from a tick on the rule. No panel, no dividers; the rule is the structure. Below 768px the readings wrap into two columns and each carries its own short rule."
    >
      <SubSection title="On the rule" note="The default: four even columns.">
        <Specimen className="!block">
          <StatRow>
            <Stat label="TVL" value="$2.4M" />
            <Stat label="APR" value={<BoostedApr value="40.0%" />} />
            <Stat label="Fees (24h)" value="$1,204" />
            <Stat label="Capacity" value="80%" />
          </StatRow>
        </Specimen>
      </SubSection>
      <SubSection title="Packed" note={<><Code>packed</Code>: readings keep their own width and sit together at the start of the rule. Used under the vault title.</>}>
        <Specimen className="!block" code="<StatRow cols={3} packed>">
          <StatRow cols={3} packed>
            <Stat label="TVL" value="$2.4M" />
            <Stat label="APR" value={<BoostedApr value="40.0%" />} />
            <Stat label="Capacity" value="$2.4M / 3M" />
          </StatRow>
        </Specimen>
      </SubSection>
      <SubSection title="Without the rule" note={<><Code>{'rule={false}'}</Code>: from 768px up the readings stand alone. Used over the scene, where a rule would cut the sky.</>}>
        <Specimen className="!block" code="<StatRow cols={2} packed rule={false}>">
          <StatRow cols={2} packed rule={false}>
            <Stat label="Total TVL" value="$11.4M" />
            <Stat label="Fees earned (24h)" value="$6,278" />
          </StatRow>
        </Specimen>
      </SubSection>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'cols', type: '2 | 3 | 4', def: '4', note: 'Columns from 768px up.' },
            { name: 'packed', type: 'boolean', note: 'Readings sit together at the start instead of spreading.' },
            { name: 'rule', type: 'boolean', def: 'true', note: 'False removes the scale and the ticks from 768px up.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function KeyValueSection() {
  return (
    <Section
      id="key-value"
      title="Key value"
      source="src/components/ui/KeyValue.tsx"
      status={NOT_IN_USE}
      lede="Facts as rows on hairlines: the name on the left, the figure on the right. A sub-row is indented and quieter, for the parts that make up the row above it."
    >
      <Specimen surface="elevated" className="!block" code="<KV rows={[{ k, v, tone?, sub? }]} />">
        <KV
          className="mx-auto max-w-[360px]"
          rows={[
            { k: 'Total APR', v: '40.0%' },
            { k: 'Trading fees', v: '27.4%', sub: true },
            { k: 'PMG rewards', v: '12.6%', sub: true, tone: 'text-accent' },
            { k: 'Fees earned', v: '+$412.80', tone: 'text-success' },
            { k: 'Withdrawal fee', v: '0.1%' },
          ]}
        />
      </Specimen>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'rows[].k', type: 'ReactNode', note: 'The name.' },
            { name: 'rows[].v', type: 'ReactNode', note: 'The value, right-aligned in tabular figures.' },
            { name: 'rows[].tone', type: 'string', def: "'text-strong'", note: 'A content class for the value: text-success, text-error, text-accent.' },
            { name: 'rows[].sub', type: 'boolean', note: 'Indents the row and quiets its name.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function BadgesSection() {
  return (
    <Section
      id="badges"
      title="Badges"
      source="src/components/ui/Badge.tsx"
      lede="Short labels that classify. A badge never relies on colour alone: the status says it in words, and the riskiest tier carries a warning sign."
    >
      <SubSection title="Range status" note="Where the price sits against the range. Not drawn anywhere yet: the vault list shows the price on its range instead.">
        <Specimen code='<RangeStatusBadge status="in" />'>
          <RangeStatusBadge status="in" />
          <RangeStatusBadge status="out" />
          <RangeStatusBadge status="defensive" />
        </Specimen>
      </SubSection>
      <SubSection title="Tier" note="The risk tier of a vault. Not drawn anywhere yet.">
        <Specimen code='<TierBadge tier="Core" />'>
          <TierBadge tier="Core" />
          <TierBadge tier="Turbo" />
          <TierBadge tier="Degen" />
        </Specimen>
      </SubSection>
      <SubSection title="Pill" note="A neutral tag for a short fact: a version, a fee tier, a count.">
        <Specimen code="<Pill>v3</Pill>">
          <Pill>v3</Pill>
          <Pill>0.05%</Pill>
          <Pill>2 adapters</Pill>
        </Specimen>
      </SubSection>
    </Section>
  );
}

function DataBadgesSection() {
  return (
    <Section
      id="data-badges"
      title="Data badges"
      source="src/components/ui/DataBadge.tsx"
      lede="Where a number comes from. Every figure on screen is either read from the deployed vault or invented for the prototype, and the interface has to say which. Hover one for the explanation."
    >
      <Specimen code='<LiveBadge />   <DemoBadge />   <DemoBadge label="Demo vault" />'>
        <LiveBadge />
        <DemoBadge />
        <DemoBadge label="Demo vault" />
      </Specimen>
      <SubSection title="Legend" note="One line at the foot of a page that mixes both kinds of number.">
        <Specimen code="<DataLegend />">
          <DataLegend />
        </Specimen>
      </SubSection>
    </Section>
  );
}

const TOKENS = ['ETH', 'USDG', 'NVDA', 'SPCX', 'SPY', 'PONS', 'CASHCAT'];

function TokenIconSection() {
  return (
    <Section
      id="token-icon"
      title="Token icon"
      source="src/components/ui/TokenIcon.tsx"
      lede="A token as a square tile. Each real mark is full-bleed, so it sits in the same square cut as everything else; a round original has its ground extended to the corners."
    >
      <SubSection title="Marks" note="The phase-one tokens. The three stock tokens show their company's mark.">
        <Specimen className="gap-x-7">
          {TOKENS.map((t) => (
            <div key={t} className="grid justify-items-center gap-2">
              <TokenIcon symbol={t} size={36} />
              <span className="font-mono text-2xs text-weaker">{t}</span>
            </div>
          ))}
        </Specimen>
      </SubSection>
      <SubSection title="Without a mark" note="A token with no artwork falls back to its initial, with the token's own colour as a rule along the bottom edge.">
        <Specimen className="gap-x-7">
          {['PMG', 'ABC'].map((t) => (
            <div key={t} className="grid justify-items-center gap-2">
              <TokenIcon symbol={t} size={36} />
              <span className="font-mono text-2xs text-weaker">{t}</span>
            </div>
          ))}
        </Specimen>
      </SubSection>
      <SubSection title="Sizes and pairs" note="A pair sets two tiles side by side. Pass the chain to add its mark at the corner.">
        <Specimen align="end" className="gap-x-9" code='<TokenPair a="ETH" b="USDG" size={36} chain="robinhood" />'>
          {[16, 22, 28, 36].map((s) => (
            <div key={s} className="grid justify-items-start gap-2">
              <TokenIcon symbol="ETH" size={s} />
              <span className="num font-mono text-2xs text-weaker">{s}px</span>
            </div>
          ))}
          <div className="grid justify-items-start gap-2">
            <TokenPair a="NVDA" b="USDG" size={22} />
            <span className="font-mono text-2xs text-weaker">pair</span>
          </div>
          <div className="grid justify-items-start gap-2 pr-2">
            <TokenPair a="ETH" b="USDG" size={36} chain="robinhood" />
            <span className="font-mono text-2xs text-weaker">pair + chain</span>
          </div>
        </Specimen>
      </SubSection>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'symbol', type: 'string', note: 'TokenIcon: which token.' },
            { name: 'a, b', type: 'string', note: 'TokenPair: the two tokens, in pair order.' },
            { name: 'size', type: 'number', def: '22', note: 'Edge of one tile, in pixels.' },
            { name: 'chain', type: 'ChainId', note: 'TokenPair: adds the chain mark at the bottom right.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function ChainLogoSection() {
  return (
    <Section
      id="chain-logo"
      title="Chain logo"
      source="src/components/ui/ChainLogo.tsx"
      lede="Robinhood Chain keeps its own feather on its own lime; any other chain is a simplified mark in one neutral tone, so the home chain is the one that stands out."
    >
      <Specimen className="gap-x-9" code='<ChainLogo chain="robinhood" size={24} />'>
        {(['robinhood', 'ethereum', 'arc'] as const).map((c) => (
          <div key={c} className="grid justify-items-start gap-2">
            <span className="flex items-end gap-2.5"><ChainLogo chain={c} size={16} /><ChainLogo chain={c} size={24} /><ChainLogo chain={c} size={36} /></span>
            <span className="font-mono text-2xs text-weaker">{c}</span>
          </div>
        ))}
      </Specimen>
    </Section>
  );
}

function BoostedAprSection() {
  return (
    <Section
      id="boosted-apr"
      title="Boosted APR"
      source="src/components/ui/BoostedApr.tsx"
      lede="An APR that includes rewards: the number in the text colour, marked with a small spark in the sun colour. The spark scales with the text, so it works at any size."
    >
      <Specimen align="baseline" className="gap-x-10" code='<BoostedApr value="40.0%" />'>
        <span className="text-sm"><BoostedApr value="32.6%" /></span>
        <span className="display num text-[22px] leading-7"><BoostedApr value="40.0%" /></span>
        <span className="display num text-4xl"><BoostedApr value="40.0%" /></span>
      </Specimen>
    </Section>
  );
}

function CollapsibleSection() {
  return (
    <Section
      id="collapsible"
      title="Collapsible"
      source="src/components/ui/Collapsible.tsx"
      status={NOT_IN_USE}
      lede="A heading that opens to its detail. For reference material a reader may want once: how fees work, what a risk means. Nothing a decision depends on belongs behind one."
    >
      <Specimen className="!block" code='<Collapsible title="How are fees charged?" defaultOpen>…</Collapsible>'>
        <div className="mx-auto grid max-w-[520px] gap-2">
          <Collapsible title="How are fees charged?" defaultOpen>
            Trading fees compound into the position automatically. The performance fee and the withdrawal fee are listed in the deposit card before you confirm.
          </Collapsible>
          <Collapsible title="What happens when the price leaves the range?">
            The position stops earning trading fees while the price is outside the range. The vault moves the range back around the price when it rebalances.
          </Collapsible>
        </div>
      </Specimen>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'title', type: 'ReactNode', note: 'The heading, always visible.' },
            { name: 'defaultOpen', type: 'boolean', def: 'false', note: 'Open on first render.' },
            { name: 'children', type: 'ReactNode', note: 'The detail.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}
