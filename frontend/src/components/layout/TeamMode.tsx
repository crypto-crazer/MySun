/**
 * Team mode's UI (the gate itself: src/lib/teamMode.ts): the hidden entry — 7 quick taps on the
 * footer's brand name — the access-code panel, and the header's STAGING chip while it is on.
 *
 * The tap target is an easter egg: no affordance, out of the a11y tree. The panel is the accessible
 * part. The typed code is never stored, logged or echoed — the field is cleared after every attempt.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { cx } from '@/lib/format';
import { teamMode, useTeamUnlocked } from '@/lib/teamMode';

/** Taps that open the panel, and the longest gap allowed between two of them. */
export const TEAM_TAPS = 7;
export const TEAM_TAP_GAP_MS = 1_200;
/** Failed attempts before submission pauses, and for how long. */
export const TEAM_MAX_FAILURES = 5;
export const TEAM_COOLDOWN_MS = 15_000;

const OpenContext = createContext<() => void>(() => {});

/** Opens the team-mode panel (the header chip uses it). A no-op outside <TeamModeProvider>. */
export function useOpenTeamMode(): () => void {
  return useContext(OpenContext);
}

/** Holds the panel's open state for the layout; renders the panel once. */
export function TeamModeProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  return (
    <OpenContext.Provider value={show}>
      {children}
      <TeamModePanel open={open} onClose={close} />
    </OpenContext.Provider>
  );
}

/**
 * The tap counter: `TEAM_TAPS` taps, each within `TEAM_TAP_GAP_MS` of the previous, call `onComplete`
 * once and start over. A slower tap starts a new count; `reset` (a tap anywhere else) clears it. A ref,
 * not state: StrictMode's double mount must not count twice, and a tap must not re-render.
 */
export function useTapCounter(onComplete: () => void) {
  const taps = useRef({ n: 0, last: 0 });
  const tap = useCallback(() => {
    const now = Date.now();
    const t = taps.current;
    t.n = t.n > 0 && now - t.last <= TEAM_TAP_GAP_MS ? t.n + 1 : 1;
    t.last = now;
    if (t.n >= TEAM_TAPS) {
      t.n = 0;
      onComplete();
    }
  }, [onComplete]);
  const reset = useCallback(() => {
    taps.current.n = 0;
  }, []);
  return { tap, reset };
}

/** The footer's brand name: the hidden tap target. */
export function TeamModeTapTarget({ children }: { children: ReactNode }) {
  const open = useOpenTeamMode();
  const { tap, reset } = useTapCounter(open);
  // A tap anywhere else breaks the sequence.
  const self = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const onDown = (e: Event) => {
      if (!self.current?.contains(e.target as Node)) reset();
    };
    document.addEventListener('click', onDown, true);
    return () => document.removeEventListener('click', onDown, true);
  }, [reset]);
  return (
    <span ref={self} aria-hidden data-team-tap="" onClick={tap} className="cursor-default select-none outline-none [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]">
      {children}
    </span>
  );
}

/** The chip's look: the DemoBadge's warning tokens, solid border. The only worded staging tag — content takes the preview mark (ui/Preview.tsx). */
const STAGING_BADGE =
  'inline-flex items-center h-6 px-2 rounded border border-stroke-warning/55 text-2xs font-medium uppercase tracking-[0.1em] leading-none text-warning whitespace-nowrap';

/** The header chip while team mode is on; opens the panel. */
export function StagingChip() {
  const unlocked = useTeamUnlocked();
  const open = useOpenTeamMode();
  if (!unlocked) return null;
  return (
    <button type="button" onClick={open} className={cx(STAGING_BADGE, 'cursor-pointer')} title="Team mode is on — staging content is visible">
      Staging
    </button>
  );
}

export function TeamModePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const unlocked = useTeamUnlocked();
  const configured = teamMode.isConfigured();
  // The attempt budget lives here, not in the form: the panel stays mounted while closed, so closing
  // and reopening it neither resets the count nor lifts a pause.
  const failures = useRef(0);
  const [coolingUntil, setCoolingUntil] = useState(0);
  const cooling = coolingUntil > 0;
  useEffect(() => {
    if (!cooling) return;
    const t = setTimeout(() => {
      failures.current = 0;
      setCoolingUntil(0);
    }, Math.max(0, coolingUntil - Date.now()));
    return () => clearTimeout(t);
  }, [cooling, coolingUntil]);
  const onFailure = useCallback(() => {
    failures.current += 1;
    if (failures.current >= TEAM_MAX_FAILURES) setCoolingUntil(Date.now() + TEAM_COOLDOWN_MS);
  }, []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Team mode"
      footer={
        unlocked ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              teamMode.lock();
              onClose();
            }}
          >
            Leave team mode
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" form="team-mode-form" size="sm" disabled={!configured || cooling}>Unlock</Button>
          </>
        )
      }
    >
      {unlocked ? (
        <p>Team mode is on — staging content is visible.</p>
      ) : (
        <UnlockForm configured={configured} cooling={cooling} onFailure={onFailure} onDone={onClose} />
      )}
    </Modal>
  );
}

function UnlockForm({ configured, cooling, onFailure, onDone }: { configured: boolean; cooling: boolean; onFailure: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!configured || cooling || busy) return;
    const attempt = code;
    setCode(''); // never kept, never echoed
    setBusy(true);
    const result = await teamMode.unlock(attempt);
    setBusy(false);
    if (result === 'ok') {
      setBad(false);
      onDone();
      return;
    }
    setBad(true);
    onFailure();
  };

  const error = cooling ? `Too many attempts — try again in ${TEAM_COOLDOWN_MS / 1000} seconds.` : bad ? "That code didn't work." : null;
  return (
    <form id="team-mode-form" onSubmit={submit} aria-busy={busy} className="grid gap-3">
      {!configured && <p>Team mode isn't configured in this build.</p>}
      <label htmlFor="team-mode-code" className="text-xs text-weak">Access code</label>
      <input
        id="team-mode-code"
        type="password"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={code}
        disabled={!configured || cooling}
        onChange={(e) => setCode(e.target.value)}
        className="h-9 w-full rounded border border-stroke-strong bg-fill-recessed px-3 text-base text-strong outline-none placeholder:text-weaker disabled:cursor-not-allowed disabled:text-disabled"
      />
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
    </form>
  );
}
