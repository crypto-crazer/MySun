/**
 * The vault spans multiple DEXs and pools at once: one IPositionAdapter per position.
 * `dex()` / `poolId()` are bytes32 ids (ascii labels on the mock; a hash / the pool address on the real
 * Uniswap adapters — see dexLabel / poolIdLabel); `position()` is the venue's spot report.
 * `deployed(i)` / `harvestable(i)` only exist on MockPositionAdapter — requested opportunistically,
 * absent (not an error) against a real adapter.
 */
import { dexLabel, formatAmount, poolIdLabel, shortHex } from '@/chain/amounts';
import type { AdapterReport, TokenMeta } from '@/chain/useVault';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Badge';

export function AdapterList({ adapters, tokens }: { adapters: AdapterReport[]; tokens: TokenMeta[] }) {
  return (
    <Card title={`Positions (${adapters.length})`} action={<span className="text-2xs text-weaker">One adapter = one pool on one DEX</span>}>
      {adapters.length === 0 ? (
        <p className="text-sm text-weaker">No adapters registered. All basket tokens sit idle in the vault.</p>
      ) : (
        <div className="space-y-3">
          {adapters.map((a) => (
            <div key={a.address} className="rounded-md border border-stroke-weak bg-fill-recessed p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="display text-sm font-semibold text-strong truncate">{dexLabel(a.dex)}</span>
                  <Pill>{poolIdLabel(a.poolId)}</Pill>
                </div>
                <a
                  className="text-2xs num text-weaker"
                  href={`#${a.address}`}
                  onClick={(e) => e.preventDefault()}
                  title={a.address}
                >
                  {shortHex(a.address)}
                </a>
              </div>

              {a.reportFailed ? (
                <p className="mt-2 text-xs text-warning">
                  position() did not report. Redeem is unaffected — it never reads an adapter.
                </p>
              ) : (
                <table className="w-full mt-2 text-xs num">
                  <thead>
                    <tr className="text-2xs text-weaker">
                      <th className="text-left font-medium py-1">Token</th>
                      <th className="text-right font-medium py-1">Position</th>
                      {a.deployed && <th className="text-right font-medium py-1">Deployed</th>}
                      {a.harvestable && <th className="text-right font-medium py-1">Harvestable</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map((t, i) => (
                      <tr key={t.address} className="border-t border-stroke-weak">
                        <td className="py-1.5 text-weak">{t.symbol}</td>
                        <td className="py-1.5 text-right text-strong">{formatAmount(a.position[i] ?? 0n, t.decimals, 4)}</td>
                        {a.deployed && <td className="py-1.5 text-right text-weak">{formatAmount(a.deployed[i] ?? 0n, t.decimals, 4)}</td>}
                        {a.harvestable && (
                          <td className="py-1.5 text-right text-success">{formatAmount(a.harvestable[i] ?? 0n, t.decimals, 4)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {a.harvestable && (
                <p className="mt-2 text-2xs text-weaker">
                  Harvestable fees are collected by the keeper's <span className="num">rebalance()</span>; the performance fee is taken
                  in kind from harvested fees only, never from principal.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
