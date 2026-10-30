import { TOKEN_COLORS } from '@/lib/tokenColors';
import type { ChainId } from '@/lib/chainBrands';
import { ChainLogo } from './ChainLogo';
import { cx } from '@/lib/format';
import eth from '@/assets/tokens/eth.svg';
import usdg from '@/assets/tokens/usdg.png';
import nvda from '@/assets/tokens/nvda.svg';
import spcx from '@/assets/tokens/spcx.svg';
import spy from '@/assets/tokens/spy.svg';
import gld from '@/assets/tokens/gld.svg';
import crcl from '@/assets/tokens/crcl.svg';
import tsla from '@/assets/tokens/tsla.svg';
import aapl from '@/assets/tokens/aapl.svg';
import amzn from '@/assets/tokens/amzn.svg';
import intc from '@/assets/tokens/intc.svg';
import mu from '@/assets/tokens/mu.svg';
import mstr from '@/assets/tokens/mstr.svg';
import pons from '@/assets/tokens/pons.png';

/**
 * Real marks, each one square and full-bleed so it sits in the same square-cut tile as everything
 * else (a round original has its ground extended to the corners). The stock tokens share one
 * official icon, so each shows its company's mark instead. Where each file comes from:
 * src/assets/tokens/SOURCES.md. A token without a mark falls back to the lettered tile.
 */
const TOKEN_ART: Record<string, string> = { ETH: eth, WETH: eth, USDG: usdg, NVDA: nvda, SPY: spy, SPCX: spcx, GLD: gld, CRCL: crcl, TSLA: tsla, AAPL: aapl, AMZN: amzn, INTC: intc, MU: mu, MSTR: mstr, PONS: pons };

/** A token as a square tile: its own mark, or its initial with the token's colour as a rule along the bottom edge. */
export function TokenIcon({ symbol, size = 22, className }: { symbol: string; size?: number; className?: string }) {
  const art = TOKEN_ART[symbol];
  if (art) {
    return (
      <span className={cx('relative inline-flex overflow-hidden rounded bg-fill-weak shrink-0 after:absolute after:inset-0 after:rounded after:border after:border-strong/15', className)} style={{ width: size, height: size }} title={symbol}>
        <img src={art} alt="" width={size} height={size} className="block h-full w-full object-cover" draggable={false} />
      </span>
    );
  }
  const color = TOKEN_COLORS[symbol] ?? 'rgb(var(--color-weaker))';
  const letter = symbol.replace(/x$/, '').slice(0, 1);
  return (
    <span
      className={cx('inline-flex items-center justify-center rounded bg-fill-weak border border-stroke-strong font-display font-bold text-strong shrink-0', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)), boxShadow: `inset 0 -2px 0 ${color}` }}
      title={symbol}
    >
      {letter}
    </span>
  );
}

export function TokenPair({ a, b, size = 22, chain }: { a: string; b: string; size?: number; chain?: ChainId }) {
  return (
    <span className="relative inline-flex items-center gap-0.5 shrink-0" style={{ width: size * 2 + 2, height: size }}>
      <TokenIcon symbol={a} size={size} />
      <TokenIcon symbol={b} size={size} />
      {chain && (
        <ChainLogo
          chain={chain}
          size={Math.round(size * 0.46)}
          className="absolute -bottom-[5px] -right-[7px] z-20 ring-[1.5px] ring-background-base"
        />
      )}
    </span>
  );
}

/** A basket of any size as overlapping tiles (the live vaults hold 2–3 tokens). */
export function TokenGroup({ symbols, size = 22 }: { symbols: readonly string[]; size?: number }) {
  return (
    <span className="relative inline-flex items-center gap-0.5 shrink-0" style={{ height: size }}>
      {symbols.map((s) => (
        <TokenIcon key={s} symbol={s} size={size} />
      ))}
    </span>
  );
}
