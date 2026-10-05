import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { InfoDot, Tooltip } from '@/components/ui/Tooltip';
import { useStore, type Toast } from '@/store/useStore';
import { Code, PropsTable, Section, Specimen, SubSection } from './parts';

export function FeedbackOverlaysContent() {
  return (
    <>
      <TooltipSection />
      <ToastSection />
      <SpinnerSection />
      <ModalSection />
    </>
  );
}

function TooltipSection() {
  return (
    <Section
      id="tooltip"
      title="Tooltip"
      source="src/components/ui/Tooltip.tsx"
      lede="A short explanation on hover or focus, on the one inverse surface in the system: sand, with night text. It explains; it never holds something the reader needs in order to act."
    >
      <SubSection title="Placement" note="Hover or tab to each.">
        <Specimen className="justify-center gap-x-10 !py-12">
          <Tooltip content="Above, centred"><Button size="sm" variant="secondary">top</Button></Tooltip>
          <Tooltip content="Below, centred" side="bottom"><Button size="sm" variant="secondary">bottom</Button></Tooltip>
          <Tooltip content="Lined up with the start" align="start"><Button size="sm" variant="secondary">align start</Button></Tooltip>
          <Tooltip content="Lined up with the end" align="end"><Button size="sm" variant="secondary">align end</Button></Tooltip>
          <Tooltip content="A wide tooltip holds a sentence or two and wraps at a fixed measure, so a longer explanation stays readable." wide><Button size="sm" variant="secondary">wide</Button></Tooltip>
        </Specimen>
      </SubSection>
      <SubSection title="Info dot" note="A small mark beside a label that has more to say.">
        <Specimen code='<InfoDot tip="…" />'>
          <span className="flex items-center gap-1.5 text-sm text-weak">Trading fees <InfoDot tip="The 7-day average, annualised." /></span>
          <span className="flex items-center gap-1.5 text-sm text-weak">PMG rewards <InfoDot wide tip="Rewards are paid in PMG on top of trading fees. They can be claimed now or locked." /></span>
        </Specimen>
      </SubSection>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'content', type: 'ReactNode', note: 'What the tooltip says.' },
            { name: 'side', type: "'top' | 'bottom'", def: "'top'", note: 'Which side of the trigger it opens on.' },
            { name: 'align', type: "'start' | 'center' | 'end'", def: "'center'", note: 'Use start or end near the edge of the page, so it stays on screen.' },
            { name: 'wide', type: 'boolean', note: 'A fixed 288px measure, for a sentence or two.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

const TOASTS: Array<{ label: string; toast: Omit<Toast, 'id'> }> = [
  { label: 'success', toast: { title: 'Deposit confirmed', detail: '1,250 USDG into ETH / USDG', tone: 'success' } },
  { label: 'accent', toast: { title: 'Claim confirmed', detail: '18.3 PMG sent to your wallet', tone: 'accent' } },
  { label: 'warning', toast: { title: 'Demo reset', detail: 'Wallet disconnected. Positions restored to defaults.', tone: 'warning' } },
  { label: 'default', toast: { title: 'Address copied' } },
];

function ToastSection() {
  const pushToast = useStore((s) => s.pushToast);
  return (
    <Section
      id="toast"
      title="Toast"
      source="src/components/ui/Toast.tsx"
      lede="A settled outcome that needs no answer. It appears at the bottom right, says what happened and to how much, and leaves after about four seconds."
    >
      <SubSection title="Tones" note="Press one to send it. The square in front is the tone; the title carries the meaning.">
        <Specimen code="pushToast({ title, detail, tone })">
          {TOASTS.map((t) => (
            <Button key={t.label} size="sm" variant="secondary" onClick={() => pushToast(t.toast)}>{t.label}</Button>
          ))}
        </Specimen>
      </SubSection>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'title', type: 'string', note: 'What happened, as a fact: "Deposit confirmed".' },
            { name: 'detail', type: 'string', note: 'The amount and where it went.' },
            { name: 'tone', type: "'default' | 'accent' | 'success' | 'warning'", def: "'default'", note: 'Accent for rewards. There is no error tone: a failure stays beside the action that failed.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}

function SpinnerSection() {
  return (
    <Section
      id="spinner"
      title="Spinner"
      source="src/components/ui/Spinner.tsx"
      lede="The busy indicator is the mark itself, with the sun rising and setting between the stones. It takes the text colour of whatever holds it."
    >
      <Specimen align="end" className="gap-x-10" code='<Spinner className="h-4 w-[26px]" />'>
        <div className="grid justify-items-start gap-2.5"><Spinner className="h-4 w-[26px] text-strong" /><span className="font-mono text-2xs text-weaker">in a button</span></div>
        <div className="grid justify-items-start gap-2.5"><Spinner className="h-6 w-[39px] text-weak" /><span className="font-mono text-2xs text-weaker">in a panel</span></div>
        <div className="grid justify-items-start gap-2.5"><Spinner className="h-10 w-[65px] text-strong" /><span className="font-mono text-2xs text-weaker">a page waiting</span></div>
      </Specimen>
      <p className="max-w-[64ch] text-sm text-weak">It is sized by class and keeps a 26:16 shape. For one button's own submit, use <Code>{'<Button loading>'}</Code> rather than placing a spinner by hand.</p>
    </Section>
  );
}

function ModalSection() {
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const close = () => {
    setOpen(false);
    setAck(false);
  };
  return (
    <Section
      id="modal"
      title="Modal"
      source="src/components/ui/Modal.tsx"
      lede="A decision that has to be made before anything else. It sits on fill-overlay with a slight blur, closes on Escape or a press outside, and keeps its actions at the bottom right. The example is the high-risk confirmation from the deposit card."
    >
      <Specimen code="<Modal open={open} onClose={close} title=… footer={…}>…</Modal>">
        <Button variant="secondary" onClick={() => setOpen(true)}>Open the dialog</Button>
      </Specimen>
      <Modal
        open={open}
        onClose={close}
        title="High-risk vault"
        footer={
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button disabled={!ack} onClick={close}>I understand, deposit</Button>
          </>
        }
      >
        <p>Degen vaults run narrow, high-frequency ranges on volatile pairs. Higher fees, higher impermanent loss risk. Net value can underperform holding.</p>
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-strong">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 accent-fill-accent" />
          <span className="text-sm">I understand this vault can lose value versus holding the underlying tokens.</span>
        </label>
      </Modal>
      <SubSection title="Props">
        <PropsTable
          rows={[
            { name: 'open', type: 'boolean', note: 'Whether it is shown.' },
            { name: 'onClose', type: '() => void', note: 'Called on Escape and on a press outside.' },
            { name: 'title', type: 'ReactNode', note: 'The question being asked, or the name of the task.' },
            { name: 'footer', type: 'ReactNode', note: 'The actions. The one that goes ahead is last, and says what it does.' },
            { name: 'children', type: 'ReactNode', note: 'The body.' },
          ]}
        />
      </SubSection>
    </Section>
  );
}
