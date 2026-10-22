import { hexConcat, hexZeroPad, hexlify } from 'ethers/lib/utils';
import { AbiPoolKey } from './types';

// Packed calldata of the Ekubo Yul router (`@ekubo/yul-router-sdk`
// `encodeRoutes`) for one multi-hop of one `forwarded` hop:
// `Core.forward(forwardee, abi.encode(poolKey, params))`.
//
//   header:    flags (1) | multi-hop count - 1 (1) | specified token (20)
//              | calculated token (20) | threshold (int128, 16) | recipient (20)
//   multi-hop: specified amount (int128, 16) | hop count - 1 (1)
//   hop:       0x01 | forwardee (20) | token0 (20) | token1 (20) | config (32)
//              | sqrt ratio limit (12) | skip ahead and partial fill flag (4)

const FLAG_RECIPIENT = 1;
const FORWARDED_HOP = 1;
const ALLOW_PARTIAL = 0x80000000n;
const MIN_I128 = -(1n << 127n);

// Byte offset of the specified amount in the calldata
export const YUL_ROUTE_SPECIFIED_AMOUNT_OFFSET = 1 + 1 + 20 + 20 + 16 + 20;

const word = (value: number | bigint, bytes: number) =>
  hexZeroPad(hexlify(value), bytes);

const int128 = (value: bigint) => word(BigInt.asUintN(128, value), 16);

export function encodeForwardedSwapRoute({
  specifiedToken,
  calculatedToken,
  specifiedAmount,
  recipient,
  poolKey,
  forwardee,
  skipAhead,
}: {
  specifiedToken: bigint;
  calculatedToken: bigint;
  specifiedAmount: bigint;
  recipient: string;
  poolKey: AbiPoolKey;
  forwardee: string;
  skipAhead: number;
}): string {
  // The aggregator enforces the slippage, so the threshold is unbounded
  const threshold = specifiedAmount < 0n ? MIN_I128 : 0n;

  return hexConcat([
    word(FLAG_RECIPIENT, 1),
    word(0, 1),
    word(specifiedToken, 20),
    word(calculatedToken, 20),
    int128(threshold),
    word(BigInt(recipient), 20),
    int128(specifiedAmount),
    word(0, 1),
    word(FORWARDED_HOP, 1),
    word(BigInt(forwardee), 20),
    word(BigInt(poolKey.token0), 20),
    word(BigInt(poolKey.token1), 20),
    word(BigInt(poolKey.config), 32),
    // default sqrt ratio limit
    word(0, 12),
    word(BigInt(skipAhead) | ALLOW_PARTIAL, 4),
  ]).toLowerCase();
}
