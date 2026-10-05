// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.34;

/// @notice Minimal subset of the Uniswap V3 factory ABI: canonical pool lookup only.
interface IUniswapV3FactoryMinimal {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}
