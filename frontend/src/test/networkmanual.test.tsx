// @vitest-environment jsdom
/**
 * NetworkManual — the hand-add parameters: the rows mirror manualNetworkParams (the registry's own
 * values), and the LAN-address reminder belongs to the demo stack only: a hosted
 * chain's RPC never moves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NetworkManual } from '@/components/live/NetworkManual';

afterEach(cleanup);

describe('NetworkManual', () => {
  it('lists the add-network fields for a hosted chain — and no LAN reminder', () => {
    render(<NetworkManual chainId={4663} />);
    expect(screen.getByText('Robinhood Chain')).toBeDefined();
    expect(screen.getByText('https://robinhood.drpc.org')).toBeDefined();
    expect(screen.getByText('4663')).toBeDefined();
    expect(screen.getByText('ETH')).toBeDefined();
    expect(screen.queryByText(/LAN address/)).toBeNull();
  });

  it('keeps the LAN reminder for the local demo stack', () => {
    render(<NetworkManual chainId={46630} />);
    expect(screen.getByText('46630')).toBeDefined();
    expect(screen.getByText(/LAN address/)).toBeDefined();
  });

  it('renders nothing for a chain not in the registry', () => {
    const { container } = render(<NetworkManual chainId={999_999} />);
    expect(container.textContent).toBe('');
  });
});
