import { useEffect, useId, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { Scene } from './Scene';
import type { DuskScene } from './duskScene';

function canUseWebGL(): boolean {
  if (typeof window === 'undefined' || !('WebGLRenderingContext' in window)) return false;
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// The scene and three.js load on demand. Asked for while rendering, so the request is out before first paint.
let sceneModule: Promise<typeof import('./duskScene')> | null = null;
function loadScene() {
  sceneModule ??= import('./duskScene').catch((err) => {
    sceneModule = null;
    throw err;
  });
  return sceneModule;
}

type Phase = 'loading' | 'live' | 'still';

/**
 * The scene, alive: the sun (the price) drifts, and when it leaves the gap the stones slide to
 * re-centre on it. Until the 3D scene is ready the frame stays dark, and the scene fades up out
 * of it; nothing else is drawn first, so there is never a second picture to cross-fade from.
 * The still drawing is the fallback, shown only when WebGL is not available.
 *
 * `offset` moves the stones sideways on wide frames so copy beside them stays clear.
 */
export function SkyScene({ className, offset = -6 }: { className?: string; offset?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const grain = `scene-${useId().replace(/:/g, '')}-grain`;
  const [phase, setPhase] = useState<Phase>(() => {
    if (!canUseWebGL()) return 'still';
    loadScene().catch(() => {});
    return 'loading';
  });

  useEffect(() => {
    if (!canUseWebGL()) return;
    let scene: DuskScene | null = null;
    let cancelled = false;
    loadScene()
      .then(({ createDuskScene }) => {
        if (cancelled || !host.current) return;
        scene = createDuskScene(host.current, { offset });
        setPhase(scene ? 'live' : 'still');
      })
      .catch(() => {
        if (!cancelled) setPhase('still');
      });
    return () => {
      cancelled = true;
      scene?.dispose();
      setPhase('loading');
    };
  }, [offset]);

  return (
    <div className={cx('isolate overflow-hidden bg-background-sheet', className)} aria-hidden>
      <Scene className={cx('absolute inset-0 h-full w-full transition-opacity duration-700', phase !== 'still' && 'opacity-0')} />
      <div
        ref={host}
        className={cx(
          'absolute inset-0 transition-opacity duration-700 [&>canvas]:absolute [&>canvas]:inset-0 [&>canvas]:block [&>canvas]:!h-full [&>canvas]:!w-full',
          phase === 'live' ? 'opacity-100' : 'opacity-0',
        )}
      />
      {/* Fixed print grain, confined to the scene beneath the interface and its text. */}
      <svg
        data-scene-grain
        className="pointer-events-none absolute inset-0 h-full w-full mix-blend-soft-light transition-opacity duration-700"
        style={{ opacity: phase === 'loading' ? 0 : 0.32 }}
      >
        <defs>
          <filter id={grain} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="2" />
            <feColorMatrix type="matrix" values="1.4 0 0 0 -.2  1.4 0 0 0 -.2  1.4 0 0 0 -.2  0 0 0 0 1" />
          </filter>
        </defs>
        <rect width="100%" height="100%" filter={`url(#${grain})`} />
      </svg>
    </div>
  );
}
