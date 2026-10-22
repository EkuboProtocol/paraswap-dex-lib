import { Result } from '@ethersproject/abi';
import { Logger } from 'log4js';
import { DeepReadonly } from 'ts-essentials';
import { IDexHelper } from '../../../dex-helper/idex-helper';
import { BlockHeader, Log } from '../../../types';
import { EkuboSupportedNetwork } from '../config';
import { BasicQuoteData, EkuboContracts } from '../types';
import { ConcentratedPoolBase, ConcentratedPoolState } from './concentrated';
import { Quote } from './pool';
import { estimatedCurrentTime } from './timed';
import { ConcentratedPoolTypeConfig, PoolKey, SwappedEvent } from './utils';
import { MAX_SQRT_RATIO, MAX_TICK, MIN_SQRT_RATIO, MIN_TICK } from './math/tick';
import {
  amountBeforeFeeV21,
  checkedI128,
  computeFeeV21,
  CoreState,
  coreSwap,
  CoreTickSearch,
  InitializedTick,
  isValidSqrtRatio,
  MevCaptureV21QuoteError,
  predSqrtRatio,
  succSqrtRatio,
  TickEvent,
  tickToSqrtRatio,
} from './math/mev-capture-v21';

// MEVCapture v2.1 charges an away-from-anchor surcharge segment by segment,
// inside `forward`: every charged Core call stops before the next segment
// boundary and before the next initialized tick, initialized ticks are crossed
// by their own uncharged "bridge" call, and each charged call is followed by
// `accumulateAsFees`. Swaps toward the anchor are one uncharged call. The
// anchor follows the pool tick with a half-life, once per timestamp, on the
// first swap of that timestamp. This file models the extension exactly.

// Gas constants fitted with forge against the deployed extension (Ekubo
// quoter-service `gas-calibration/mevcapture-v21`), per forwarded swap through
// the Yul router.
const BASE_GAS_COST_OF_ONE_YUL_ROUTE = 5_700 + 400;
const GAS_COST_OF_ONE_YUL_ROUTER_SWAP = 7_900 + 1_050;
const GAS_COST_OF_COLD_EXTENSION_ACCESS = 2_500;
const EXTRA_BASE_GAS_COST_OF_ONE_MEV_CAPTURE_V21_SWAP = 8_250;
const GAS_COST_OF_ONE_CORE_CALL = 12_350;
const GAS_COST_OF_ONE_EXTRA_CORE_STEP = 2_850;
const GAS_COST_OF_ONE_INITIALIZED_TICK_CROSSED = 13_150;
const GAS_COST_OF_ONE_FEE_ACCUMULATION = 7_950;
const GAS_COST_OF_ANCHOR_UPDATE = 4_650;

const MAX_TICK_SPACING = 698_605;

// The extension's `getConfig()`
export interface MevCaptureV21Config {
  halfLife: number;
  slopeK: number;
  segmentExp: number;
  jLin: number;
  // Q0.64, like the pool fee
  maxFee: bigint;
  clampTicks: number;
  mGate: number;
}

// The extension's `getAnchor(poolId)`. Times are uint32 seconds.
export interface MevCaptureV21Anchor {
  lastUpdateTime: number;
  lRefTime: number;
  lastPosTime: number;
  lRefBits: number;
  snapBits: number;
  lRefRaiseTime: number;
  anchorX16: bigint;
}

export interface MevCaptureV21Gate {
  passed: boolean;
  lObs: number;
  eRef: number;
}

const isUint = (x: number, max: number) =>
  Number.isInteger(x) && x >= 0 && x <= max;

export function validateMevCaptureV21Config(
  c: MevCaptureV21Config,
): MevCaptureV21Config {
  const ranges: [number, number, number][] = [
    [c.halfLife, 1, 1 << 20],
    [c.slopeK, 1, 16],
    [c.segmentExp, 0, 8],
    [c.jLin, 1, 64],
    [c.clampTicks, 1, 2 * MAX_TICK],
    [c.mGate, 0, 16],
  ];
  const valid =
    ranges.every(([x, min, max]) => isUint(x, max) && x >= min) &&
    typeof c.maxFee === 'bigint' &&
    c.maxFee > 0n &&
    c.maxFee <= 1n << 63n;
  if (!valid) throw new RangeError('MEVCaptureV21: invalid configuration');
  return { ...c };
}

const sub32 = (a: number, b: number) => (a - b) >>> 0;

function bitLength(x: bigint): number {
  return x === 0n ? 0 : x.toString(2).length;
}

const EXP2_FACTORS: readonly bigint[] = [
  0x16a09e667f3bcc908b2fb1366ea957d3en,
  0x1306fe0a31b7152de8d5a46305c85edecn,
  0x1172b83c7d517adcdf7c8c50eb14a791fn,
  0x10b5586cf9890f6298b92b71842a98363n,
  0x1059b0d31585743ae7c548eb68ca417fdn,
  0x102c9a3e778060ee6f7caca4f7a29bde8n,
  0x10163da9fb33356d84a66ae336dcdfa3fn,
  0x100b1afa5abcbed6129ab13ec11dc9543n,
  0x10058c86da1c09ea1ff19d294cf2f679bn,
  0x1002c605e2e8cec506d21bfc89a23a00fn,
  0x100162f3904051fa128bca9c55c31e5dfn,
  0x1000b175effdc76ba38e31671ca939725n,
  0x100058ba01fb9f96d6cacd4b180917c3dn,
  0x10002c5cc37da9491d0985c348c68e7b3n,
  0x1000162e525ee054754457d5995292026n,
  0x10000b17255775c040618bf4a4ade83fcn,
  0x1000058b91b5bc9ae2eed81e9b7d4cfabn,
  0x100002c5c89d5ec6ca4d7c8acc017b7c9n,
  0x10000162e43f4f831060e02d839a9d16dn,
  0x100000b1721bcfc99d9f890ea06911763n,
  0x10000058b90cf1e6d97f9ca14dbcc1628n,
  0x1000002c5c863b73f016468f6bac5ca2bn,
  0x100000162e430e5a18f6119e3c02282a5n,
  0x1000000b1721835514b86e6d96efd1bfen,
  0x100000058b90c0b48c6be5df846c5b2efn,
  0x10000002c5c8601cc6b9e94213c72737an,
  0x1000000162e42fff037df38aa2b219f06n,
  0x10000000b17217fba9c739aa5819f44f9n,
  0x1000000058b90bfcdee5acd3c1cedc823n,
  0x100000002c5c85fe31f35a6a30da1be50n,
  0x10000000162e42ff0999ce3541b9fffcfn,
  0x100000000b17217f80f4ef5aadda45554n,
  0x10000000058b90bfbf8479bd5a81b51adn,
  0x1000000002c5c85fdf84bd62ae30a74ccn,
  0x100000000162e42fefb2fed257559bdaan,
  0x1000000000b17217f7d5a7716bba4a9aen,
  0x100000000058b90bfbe9ddbac5e109ccen,
  0x10000000002c5c85fdf4b15de6f17eb0dn,
  0x1000000000162e42fefa494f1478fde05n,
  0x10000000000b17217f7d20cf927c8e94cn,
  0x1000000000058b90bfbe8f71cb4e4b33dn,
  0x100000000002c5c85fdf477b662b26945n,
  0x10000000000162e42fefa3ae53369388cn,
  0x100000000000b17217f7d1d351a389d40n,
  0x10000000000058b90bfbe8e8b2d3d4eden,
  0x1000000000002c5c85fdf4741bea6e77en,
  0x100000000000162e42fefa39fe95583c2n,
  0x1000000000000b17217f7d1cfb72b45e1n,
  0x100000000000058b90bfbe8e7cc35c3f0n,
  0x10000000000002c5c85fdf473e242ea38n,
  0x1000000000000162e42fefa39f02b772cn,
  0x10000000000000b17217f7d1cf7d83c1an,
  0x1000000000000058b90bfbe8e7bdcbe2en,
  0x100000000000002c5c85fdf473dea871fn,
  0x10000000000000162e42fefa39ef44d91n,
  0x100000000000000b17217f7d1cf79e949n,
  0x10000000000000058b90bfbe8e7bce544n,
  0x1000000000000002c5c85fdf473de6ecan,
  0x100000000000000162e42fefa39ef366fn,
  0x1000000000000000b17217f7d1cf79afan,
  0x100000000000000058b90bfbe8e7bcd6dn,
  0x10000000000000002c5c85fdf473de6b2n,
  0x1000000000000000162e42fefa39ef358n,
  0x10000000000000000b17217f7d1cf79abn,
];

// The extension's `exp2`: unsigned 5.64 input, unsigned 64.64 output. The
// factors are applied from the highest fraction bit down, rounding after each
// product, exactly as the unrolled on-chain version does.
export function mevCaptureV21Exp2(x: bigint): bigint {
  if (x < 0n || x >= 64n << 64n)
    throw new RangeError('MEVCaptureV21: exp2 input out of range');
  let result = 1n << 127n;
  for (let i = 0; i < 64; i++) {
    if ((x >> BigInt(63 - i)) & 1n) result = (result * EXP2_FACTORS[i]) >> 128n;
  }
  return result >> (63n - (x >> 64n));
}

// The anchor state machine of the extension
export class MevCaptureV21Model {
  public readonly config: MevCaptureV21Config;

  public constructor(config: MevCaptureV21Config) {
    this.config = validateMevCaptureV21Config(config);
  }

  // `beforeInitializePool`
  public initialize(tick: number, now: number): MevCaptureV21Anchor {
    return {
      lastUpdateTime: now,
      lRefTime: now,
      lastPosTime: 0,
      lRefBits: 0,
      snapBits: 0,
      lRefRaiseTime: sub32(now, this.config.halfLife),
      anchorX16: BigInt(tick) << 16n,
    };
  }

  // `beforeUpdatePosition`: snapshot of the active liquidity, once per timestamp. Mutates `state`.
  public beforePosition(
    state: MevCaptureV21Anchor,
    liquidity: bigint,
    now: number,
  ): void {
    if (state.lastPosTime !== now) {
      state.lastPosTime = now;
      state.snapBits = bitLength(liquidity);
    }
  }

  private decayedReference(state: MevCaptureV21Anchor, now: number): number {
    const decay = Math.floor(sub32(now, state.lRefTime) / this.config.halfLife);
    return Math.max(0, state.lRefBits - decay);
  }

  private raise(
    base: number,
    observed: number,
    now: number,
    raiseTime: number,
  ): [number, number] {
    if (observed > base && sub32(now, raiseTime) >= this.config.halfLife)
      return [base + 1, now];
    return [base, raiseTime];
  }

  // The anchor movement toward the current tick, clamped by the allowance
  private moveAnchor(anchorX16: bigint, tick: number, dt: number): bigint {
    const { halfLife, clampTicks } = this.config;
    const offset = anchorX16 - (BigInt(tick) << 16n);
    const halvings = Math.floor(dt / halfLife);
    const abs = offset < 0n ? -offset : offset;
    const shifted = halvings >= 128 ? 0n : abs >> BigInt(halvings);
    const fraction = (BigInt(dt % halfLife) << 64n) / BigInt(halfLife);
    const magnitude = (shifted << 64n) / mevCaptureV21Exp2(fraction);
    const decayed = offset < 0n ? -magnitude : magnitude;
    // the allowance rounds up, so every update that consumes elapsed time
    // grants at least one 2^-16 tick
    const hl = BigInt(halfLife);
    const limit =
      ((BigInt(clampTicks) << 16n) * BigInt(Math.min(dt, halfLife)) + hl - 1n) /
      hl;
    const move = decayed - offset;
    return anchorX16 + (move > limit ? limit : move < -limit ? -limit : move);
  }

  // `_anchorUpdate`, run only on the first swap of a timestamp; `null` otherwise. Mutates `state`.
  public beforeSwap(
    state: MevCaptureV21Anchor,
    tick: number,
    liquidity: bigint,
    now: number,
  ): MevCaptureV21Gate | null {
    if (state.lastUpdateTime === now) return null;
    const dt = sub32(now, state.lastUpdateTime);
    const lObs =
      state.lastPosTime === now ? state.snapBits : bitLength(liquidity);
    const eRef = this.decayedReference(state, now);
    const passed = lObs + this.config.mGate >= eRef;
    if (passed) {
      state.anchorX16 = this.moveAnchor(state.anchorX16, tick, dt);
      const base = Math.max(eRef, Math.min(state.lRefBits, lObs));
      [state.lRefBits, state.lRefRaiseTime] = this.raise(
        base,
        lObs,
        now,
        state.lRefRaiseTime,
      );
      state.lRefTime = now;
    }
    state.lastUpdateTime = now;
    return { passed, lObs, eRef };
  }

  // `_refresh`: raises the reference from the liquidity after the swap. Mutates `state`.
  public afterSwap(
    state: MevCaptureV21Anchor,
    liquidity: bigint,
    now: number,
  ): void {
    if (state.lastPosTime === now) return;
    const e = this.decayedReference(state, now);
    const [raised, raiseTime] = this.raise(
      e,
      bitLength(liquidity),
      now,
      state.lRefRaiseTime,
    );
    if (raised !== e) {
      state.lRefBits = raised;
      state.lRefTime = now;
      state.lRefRaiseTime = raiseTime;
    }
  }
}

const floorDiv = (a: bigint, b: bigint) => {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
};

// Away segments in mirrored Q16 tick coordinates (the swap always moves toward larger values)
class Grid {
  public readonly w16: bigint;
  public readonly g1: bigint;
  public readonly gJ: bigint;
  public readonly jLin: number;

  public constructor(a: bigint, spacing: number, config: MevCaptureV21Config) {
    this.w16 = BigInt(spacing) << BigInt(config.segmentExp + 16);
    this.g1 = (floorDiv(a, this.w16) + 1n) * this.w16;
    this.gJ = this.g1 + BigInt(config.jLin - 1) * this.w16;
    this.jLin = config.jLin;
  }

  public boundary(k: number): bigint {
    if (k <= this.jLin) return this.g1 + BigInt(k - 1) * this.w16;
    return this.gJ + ((1n << BigInt(k - this.jLin + 1)) - 2n) * this.w16;
  }

  public firstSegment(p: bigint): number {
    const p16 = p << 16n;
    if (p16 < this.g1) return 1;
    if (p16 < this.gJ) return Number((p16 - this.g1) / this.w16 + 2n);
    return this.jLin - 1 + bitLength((p16 - this.gJ) / this.w16 + 2n);
  }
}

function surcharge(
  config: MevCaptureV21Config,
  poolFee: bigint,
  twiceMidX16: bigint,
  spacing: number,
) {
  const den = BigInt(spacing) << 18n;
  const sur = (BigInt(config.slopeK) * poolFee * twiceMidX16 + den - 1n) / den;
  const cap = config.maxFee - poolFee;
  return sur > cap ? cap : sur;
}

// Execution resources of one forwarded swap
export interface MevCaptureV21Resources {
  coreCalls: number;
  // Core swap loop iterations, summed over calls
  coreSteps: number;
  initializedTicksCrossed: number;
  bridges: number;
  accumulateAsFees: number;
  // 1 when this swap runs the first anchor update of its timestamp
  anchorUpdates: number;
}

export type MevCaptureV21CallKind =
  // zero amount or price already at the limit: the parameters are passed through
  | { kind: 'passThrough' }
  // the uncut, uncharged call toward the anchor
  | { kind: 'toward' }
  // a call in away segment `k` (1-based), charged `surcharge` (Q0.64) on the calculated token
  | { kind: 'charged'; k: number; surcharge: bigint }
  // one representable step onto an initialized tick, uncharged
  | { kind: 'bridge' };

// One `Core.swap` call made by the extension
export interface MevCaptureV21CoreCall {
  kind: MevCaptureV21CallKind;
  sqrtRatioLimit: bigint;
  // the remaining specified amount passed to Core
  amount: bigint;
  // Core's balance update (positive: paid to the pool)
  delta0: bigint;
  delta1: bigint;
  // surcharge passed to `accumulateAsFees` right after the call
  surcharge0: bigint;
  surcharge1: bigint;
  stateBefore: CoreState;
  stateAfter: CoreState;
  steps: number;
  initializedTicksCrossed: number;
}

export interface MevCaptureV21SwapParams {
  isToken1: boolean;
  // positive for exact input, negative for exact output
  amount: bigint;
  // omitted is the contract default (minimum or maximum sqrt ratio)
  sqrtRatioLimit?: bigint;
  skipAhead?: number;
}

export interface MevCaptureV21Swap {
  // set on the first swap of a timestamp
  gate: MevCaptureV21Gate | null;
  anchorX16: bigint;
  calls: MevCaptureV21CoreCall[];
  // the forwarded balance update (Core deltas plus surcharges)
  delta0: bigint;
  delta1: bigint;
  surcharge0: bigint;
  surcharge1: bigint;
  coreStateAfter: CoreState;
  anchorAfter: MevCaptureV21Anchor;
  resources: MevCaptureV21Resources;
}

const nearer = (increasing: boolean, x: bigint, y: bigint) =>
  increasing === x < y ? x : y;

interface SegmentRun {
  params: Required<MevCaptureV21SwapParams>;
  increasing: boolean;
  exactOut: boolean;
  search: CoreTickSearch;
  current: CoreState;
  remaining: bigint;
  calls: MevCaptureV21CoreCall[];
}

// A concentrated pool behind MEVCapture v2.1. Quotes are exact for the given
// initialized ticks: Core's bitmap words and `skipAhead` are emulated because
// the extension cuts calls at Core's tick events, so every initialized tick
// the swap can reach must be supplied, including one whose net delta is zero.
export class MevCaptureV21Simulator {
  public readonly model: MevCaptureV21Model;

  public constructor(
    config: MevCaptureV21Config,
    public readonly poolFee: bigint,
    public readonly tickSpacing: number,
    public readonly ticks: readonly InitializedTick[],
  ) {
    this.model = new MevCaptureV21Model(config);
    if (poolFee <= 0n || poolFee >= this.model.config.maxFee) {
      throw new RangeError(
        'MEVCaptureV21: pool fee must be non-zero and below maxFee',
      );
    }
    if (!isUint(tickSpacing, MAX_TICK_SPACING) || tickSpacing === 0) {
      throw new RangeError('MEVCaptureV21: invalid tick spacing');
    }
  }

  // Simulates `forward`: the anchor update, the toward call, the away
  // segments (rate cuts, tick cuts, bridges, surcharges) and the refresh
  public simulateSwap(
    core: CoreState,
    anchor: DeepReadonly<MevCaptureV21Anchor>,
    params: MevCaptureV21SwapParams,
    now: number,
  ): MevCaptureV21Swap {
    const nextAnchor = { ...anchor };
    const gate = this.model.beforeSwap(
      nextAnchor,
      core.tick,
      core.liquidity,
      now,
    );
    const swap = this.swapThroughSegments(core, params, nextAnchor.anchorX16);
    this.model.afterSwap(nextAnchor, swap.coreStateAfter.liquidity, now);
    swap.gate = gate;
    swap.resources.anchorUpdates = gate === null ? 0 : 1;
    swap.anchorAfter = nextAnchor;
    return swap;
  }

  // `_swapThroughSegments` with a given anchor (no anchor update or refresh)
  public swapThroughSegments(
    core: CoreState,
    params: MevCaptureV21SwapParams,
    anchorX16: bigint,
  ): MevCaptureV21Swap {
    const run = this.startRun(core, params);
    const userLimit = run.params.sqrtRatioLimit;
    if (run.remaining === 0n || run.current.sqrtRatio === userLimit) {
      this.call(run, { kind: 'passThrough' }, userLimit);
    } else if (!this.toward(run, anchorX16)) {
      this.away(run, anchorX16);
    }
    return this.summarize(run, anchorX16);
  }

  private startRun(core: CoreState, params: MevCaptureV21SwapParams) {
    const exactOut = params.amount < 0n;
    const increasing = params.isToken1 !== exactOut;
    const sqrtRatioLimit =
      params.sqrtRatioLimit ?? (increasing ? MAX_SQRT_RATIO : MIN_SQRT_RATIO);
    if (!isValidSqrtRatio(sqrtRatioLimit)) {
      throw new MevCaptureV21QuoteError('InvalidSqrtRatioLimit');
    }
    checkedI128(params.amount);
    const skipAhead = params.skipAhead ?? 0;
    return {
      params: {
        isToken1: params.isToken1,
        amount: params.amount,
        sqrtRatioLimit,
        skipAhead,
      },
      increasing,
      exactOut,
      search: new CoreTickSearch(this.ticks, this.tickSpacing, skipAhead),
      current: { ...core },
      remaining: params.amount,
      calls: [],
    };
  }

  // The uncut, uncharged call toward the anchor; returns whether the swap is finished
  private toward(run: SegmentRun, anchorX16: bigint): boolean {
    const { increasing } = run;
    // floor of the mirrored anchor, mapped back: a ceiling when decreasing
    const mirroredTick = increasing ? anchorX16 >> 16n : -(-anchorX16 >> 16n);
    const anchorTick = Math.min(
      MAX_TICK,
      Math.max(MIN_TICK, Number(mirroredTick)),
    );
    const anchorRatio = tickToSqrtRatio(anchorTick);
    if (
      run.current.sqrtRatio === anchorRatio ||
      increasing !== run.current.sqrtRatio < anchorRatio
    ) {
      return false;
    }
    const limit = nearer(increasing, anchorRatio, run.params.sqrtRatioLimit);
    this.call(run, { kind: 'toward' }, limit);
    return (
      run.remaining === 0n ||
      limit === run.params.sqrtRatioLimit ||
      run.current.sqrtRatio !== limit
    );
  }

  private away(run: SegmentRun, anchorX16: bigint): void {
    const { increasing } = run;
    const config = this.model.config;
    const a = increasing ? anchorX16 : -anchorX16;
    const grid = new Grid(a, this.tickSpacing, config);
    const p = increasing
      ? BigInt(run.current.tick)
      : -BigInt(run.current.tick) - 1n;
    let k = grid.firstSegment(p);
    let lo = k === 1 ? a : grid.boundary(k - 1);
    for (;;) {
      const hi = grid.boundary(k);
      const sur = surcharge(
        config,
        this.poolFee,
        lo + hi - 2n * a,
        this.tickSpacing,
      );
      const rateLimit = this.rateLimit(
        run,
        hi,
        sur === config.maxFee - this.poolFee,
      );
      if (rateLimit === null) {
        lo = hi;
        k += 1;
        continue;
      }
      this.awayCall(run, rateLimit, { kind: 'charged', k, surcharge: sur });
      if (
        run.remaining === 0n ||
        run.current.sqrtRatio === run.params.sqrtRatioLimit
      )
        return;
    }
  }

  // The limit at the segment's rate boundary; `null` if the price is already past it
  private rateLimit(
    run: SegmentRun,
    hi: bigint,
    capped: boolean,
  ): bigint | null {
    const userLimit = run.params.sqrtRatioLimit;
    const hiTick = hi >> 16n;
    if (capped || hiTick > BigInt(MAX_TICK)) return userLimit;
    const { increasing } = run;
    const boundary = tickToSqrtRatio(Number(increasing ? hiTick : -hiTick));
    if (
      increasing
        ? boundary <= run.current.sqrtRatio
        : boundary >= run.current.sqrtRatio
    )
      return null;
    return nearer(increasing, boundary, userLimit);
  }

  private nextEvent(run: SegmentRun): { event: TickEvent; ratio: bigint } {
    const { increasing, search } = run;
    let event = search.search(run.current.tick, increasing);
    let ratio = tickToSqrtRatio(event.tick);
    if (ratio === run.current.sqrtRatio) {
      event = search.search(
        increasing ? event.tick : event.tick - 1,
        increasing,
      );
      ratio = tickToSqrtRatio(event.tick);
    }
    return { event, ratio };
  }

  // One away call: cut short of the next initialized tick, or a bridge onto it
  private awayCall(
    run: SegmentRun,
    rateLimit: bigint,
    charged: MevCaptureV21CallKind,
  ): void {
    const { increasing } = run;
    const { event, ratio } = this.nextEvent(run);
    if (event.index === null) {
      this.call(run, charged, nearer(increasing, ratio, rateLimit));
      return;
    }
    const cut = increasing ? predSqrtRatio(ratio) : succSqrtRatio(ratio);
    if (cut === run.current.sqrtRatio) {
      this.call(
        run,
        { kind: 'bridge' },
        nearer(increasing, ratio, run.params.sqrtRatioLimit),
      );
    } else {
      this.call(run, charged, nearer(increasing, cut, rateLimit));
    }
  }

  // The surcharge on a charged call's calculated token
  private callSurcharge(
    run: SegmentRun,
    kind: MevCaptureV21CallKind,
    calculated: bigint,
  ): bigint {
    if (kind.kind !== 'charged' || kind.surcharge === 0n) return 0n;
    if (!run.exactOut)
      return computeFeeV21(
        calculated < 0n ? -calculated : calculated,
        kind.surcharge,
      );
    const inputNet = calculated - computeFeeV21(calculated, this.poolFee);
    return amountBeforeFeeV21(inputNet, kind.surcharge) - inputNet;
  }

  // Runs one Core call and, for a charged call, the surcharge on its calculated token
  private call(
    run: SegmentRun,
    kind: MevCaptureV21CallKind,
    limit: bigint,
  ): void {
    const { isToken1 } = run.params;
    const before = run.current;
    const r = coreSwap(run.search, before, {
      fee: this.poolFee,
      isToken1,
      amount: run.remaining,
      limit,
    });
    const fee = this.callSurcharge(run, kind, isToken1 ? r.delta0 : r.delta1);
    const specified = isToken1 ? r.delta1 : r.delta0;
    run.calls.push({
      kind,
      sqrtRatioLimit: limit,
      amount: run.remaining,
      delta0: r.delta0,
      delta1: r.delta1,
      surcharge0: isToken1 ? fee : 0n,
      surcharge1: isToken1 ? 0n : fee,
      stateBefore: before,
      stateAfter: r.state,
      steps: r.steps,
      initializedTicksCrossed: r.crossed,
    });
    const progressed = !coreEquals(r.state, before) || specified !== 0n;
    run.remaining = checkedI128(run.remaining - specified);
    run.current = r.state;
    if (
      !progressed &&
      run.remaining !== 0n &&
      run.current.sqrtRatio !== run.params.sqrtRatioLimit
    ) {
      throw new MevCaptureV21QuoteError(
        'NoProgress',
        'a Core call moved neither the price nor the amount',
      );
    }
  }

  private summarize(run: SegmentRun, anchorX16: bigint): MevCaptureV21Swap {
    let [delta0, delta1, surcharge0, surcharge1] = [0n, 0n, 0n, 0n];
    const resources: MevCaptureV21Resources = {
      coreCalls: run.calls.length,
      coreSteps: 0,
      initializedTicksCrossed: 0,
      bridges: 0,
      accumulateAsFees: 0,
      anchorUpdates: 0,
    };
    for (const c of run.calls) {
      delta0 = checkedI128(delta0 + c.delta0 + checkedI128(c.surcharge0));
      delta1 = checkedI128(delta1 + c.delta1 + checkedI128(c.surcharge1));
      surcharge0 += c.surcharge0;
      surcharge1 += c.surcharge1;
      resources.coreSteps += c.steps;
      resources.initializedTicksCrossed += c.initializedTicksCrossed;
      resources.bridges += c.kind.kind === 'bridge' ? 1 : 0;
      resources.accumulateAsFees += c.surcharge0 + c.surcharge1 !== 0n ? 1 : 0;
    }
    return {
      gate: null,
      anchorX16,
      calls: run.calls,
      delta0,
      delta1,
      surcharge0,
      surcharge1,
      coreStateAfter: run.current,
      // set by `simulateSwap`, which also runs the anchor update
      anchorAfter: { ...zeroAnchor(), anchorX16 },
      resources,
    };
  }
}

function zeroAnchor(): MevCaptureV21Anchor {
  return {
    lastUpdateTime: 0,
    lRefTime: 0,
    lastPosTime: 0,
    lRefBits: 0,
    snapBits: 0,
    lRefRaiseTime: 0,
    anchorX16: 0n,
  };
}

function coreEquals(a: CoreState, b: CoreState): boolean {
  return (
    a.sqrtRatio === b.sqrtRatio &&
    a.tick === b.tick &&
    a.liquidity === b.liquidity
  );
}

export function mevCaptureV21GasCost(r: MevCaptureV21Resources): number {
  return (
    BASE_GAS_COST_OF_ONE_YUL_ROUTE +
    GAS_COST_OF_ONE_YUL_ROUTER_SWAP +
    GAS_COST_OF_COLD_EXTENSION_ACCESS +
    EXTRA_BASE_GAS_COST_OF_ONE_MEV_CAPTURE_V21_SWAP +
    GAS_COST_OF_ONE_CORE_CALL * r.coreCalls +
    GAS_COST_OF_ONE_EXTRA_CORE_STEP * Math.max(0, r.coreSteps - r.coreCalls) +
    GAS_COST_OF_ONE_INITIALIZED_TICK_CROSSED * r.initializedTicksCrossed +
    GAS_COST_OF_ONE_FEE_ACCUMULATION * r.accumulateAsFees +
    GAS_COST_OF_ANCHOR_UPDATE * r.anchorUpdates
  );
}

export namespace MevCaptureV21PoolState {
  export type Object = ConcentratedPoolState.Object & {
    readonly config: MevCaptureV21Config;
    readonly anchor: MevCaptureV21Anchor;
    // timestamp of the block this state is at
    readonly blockTimestamp: number;
  };

  export function fromQuoter(
    data: BasicQuoteData,
    config: MevCaptureV21Config,
    anchor: MevCaptureV21Anchor,
    blockTimestamp: number,
  ): DeepReadonly<Object> {
    return {
      ...ConcentratedPoolState.fromQuoter(data),
      config,
      anchor,
      blockTimestamp,
    };
  }

  // The initialized ticks strictly inside the range the state was fetched
  // for. The range bounds carry the liquidity of ticks outside of it and are
  // not initialized ticks of Core, so quotes stop at them instead.
  export function initializedTicks(
    state: DeepReadonly<Object>,
  ): InitializedTick[] {
    const [low, high] = state.checkedTicksBounds;
    return state.sortedTicks
      .filter(t => t.number > low && t.number < high)
      .map(t => ({ index: t.number, liquidityDelta: t.liquidityDelta }));
  }
}

export function parseMevCaptureV21Config(raw: Result): MevCaptureV21Config {
  return validateMevCaptureV21Config({
    halfLife: Number(raw.halfLife),
    slopeK: Number(raw.slopeK),
    segmentExp: Number(raw.segmentExp),
    jLin: Number(raw.jLin),
    maxFee: BigInt(raw.maxFee.toString()),
    clampTicks: Number(raw.clampTicks),
    mGate: Number(raw.mGate),
  });
}

export function parseMevCaptureV21Anchor(raw: Result): MevCaptureV21Anchor {
  return {
    lastUpdateTime: Number(raw.lastUpdateTime),
    lRefTime: Number(raw.lRefTime),
    lastPosTime: Number(raw.lastPosTime),
    lRefBits: Number(raw.lRefBits),
    snapBits: Number(raw.snapBits),
    lRefRaiseTime: Number(raw.lRefRaiseTime),
    anchorX16: BigInt(raw.anchorX16.toString()),
  };
}

export type MevCaptureV21Quote = Quote & {
  swap: MevCaptureV21Swap;
};

export function quoteMevCaptureV21(
  key: PoolKey<ConcentratedPoolTypeConfig>,
  amount: bigint,
  isToken1: boolean,
  state: DeepReadonly<MevCaptureV21PoolState.Object>,
  now: number,
  sqrtRatioLimit?: bigint,
  skipAhead = 0,
): MevCaptureV21Quote {
  const simulator = new MevCaptureV21Simulator(
    state.config,
    key.config.fee,
    key.config.poolTypeConfig.tickSpacing,
    MevCaptureV21PoolState.initializedTicks(state),
  );
  const increasing = isToken1 !== amount < 0n;
  const [low, high] = state.checkedTicksBounds;
  // stop at the range the state covers; within it this changes no Core call
  const rangeLimit = tickToSqrtRatio(increasing ? high : low);
  const swap = simulator.simulateSwap(
    {
      sqrtRatio: state.sqrtRatio,
      tick: state.activeTick,
      liquidity: state.liquidity,
    },
    state.anchor,
    {
      isToken1,
      amount,
      sqrtRatioLimit:
        sqrtRatioLimit === undefined
          ? rangeLimit
          : increasing === sqrtRatioLimit < rangeLimit
          ? sqrtRatioLimit
          : rangeLimit,
      skipAhead,
    },
    now,
  );
  const [specified, calculated] = isToken1
    ? [swap.delta1, swap.delta0]
    : [swap.delta0, swap.delta1];
  return {
    consumedAmount: specified,
    calculatedAmount: calculated < 0n ? -calculated : calculated,
    gasConsumed: mevCaptureV21GasCost(swap.resources),
    skipAhead,
    swap,
  };
}

export class MevCaptureV21Pool extends ConcentratedPoolBase<MevCaptureV21PoolState.Object> {
  private readonly extension;
  private readonly positionUpdatedTopic: string;
  private readonly chainId: EkuboSupportedNetwork;

  public constructor(
    parentName: string,
    dexHelper: IDexHelper,
    logger: Logger,
    contracts: EkuboContracts,
    initBlockNumber: number,
    key: PoolKey<ConcentratedPoolTypeConfig>,
  ) {
    super(parentName, dexHelper, logger, contracts, initBlockNumber, key);

    this.extension = contracts.mevCaptureV21.contract;
    this.positionUpdatedTopic =
      contracts.core.interface.getEventTopic('PositionUpdated');
    this.chainId = dexHelper.config.data.network;
  }

  public override async generateState(
    blockNumber: number,
  ): Promise<DeepReadonly<MevCaptureV21PoolState.Object>> {
    return this.fetchState(blockNumber);
  }

  private async fetchState(
    blockNumber: number,
    blockTimestamp?: number,
  ): Promise<DeepReadonly<MevCaptureV21PoolState.Object>> {
    const overrides = { blockTag: blockNumber };
    const [quoteData, config, anchor, timestamp] = await Promise.all([
      this.quoteDataFetcher.getQuoteData(
        [this.key.toAbi()],
        10,
        overrides,
      ) as Promise<BasicQuoteData[]>,
      this.extension.getConfig(overrides) as Promise<Result>,
      this.fetchAnchor(blockNumber),
      blockTimestamp ??
        this.dexHelper.provider
          .getBlock(blockNumber)
          .then(block => block.timestamp),
    ]);

    return MevCaptureV21PoolState.fromQuoter(
      quoteData[0],
      parseMevCaptureV21Config(config),
      anchor,
      timestamp,
    );
  }

  private async fetchAnchor(blockNumber: number): Promise<MevCaptureV21Anchor> {
    return parseMevCaptureV21Anchor(
      await this.extension.getAnchor(this.poolId(), { blockTag: blockNumber }),
    );
  }

  private poolId(): string {
    return '0x' + this.key.numId.toString(16).padStart(64, '0');
  }

  // The extension changes its anchor without an event (on the first swap of a
  // timestamp and on position updates), so it is read again for every block
  // with logs of the pool. A position update can also change which ticks are
  // initialized in a way the net liquidity deltas don't show, so the whole
  // state is read again then.
  protected override async processBlockLogs(
    state: DeepReadonly<MevCaptureV21PoolState.Object>,
    logs: Readonly<Log>[],
    blockHeader: Readonly<BlockHeader>,
  ): Promise<DeepReadonly<MevCaptureV21PoolState.Object> | null> {
    const blockTimestamp = Number(blockHeader.timestamp);

    if (logs.some(log => log.topics[0] === this.positionUpdatedTopic)) {
      return this.fetchState(blockHeader.number, blockTimestamp);
    }

    const [next, anchor] = await Promise.all([
      super.processBlockLogs(state, logs, blockHeader),
      this.fetchAnchor(blockHeader.number),
    ]);

    return { ...(next ?? state), anchor, blockTimestamp };
  }

  protected override _quote(
    amount: bigint,
    isToken1: boolean,
    state: DeepReadonly<MevCaptureV21PoolState.Object>,
  ): Quote {
    const now = Number(
      estimatedCurrentTime(BigInt(state.blockTimestamp), this.chainId),
    );
    const { swap: _swap, ...quote } = quoteMevCaptureV21(
      this.key,
      amount,
      isToken1,
      state,
      now,
    );
    return quote;
  }

  protected override handlePositionUpdated(
    _args: Result,
    oldState: DeepReadonly<MevCaptureV21PoolState.Object>,
  ): DeepReadonly<MevCaptureV21PoolState.Object> | null {
    // `processBlockLogs` reads the whole state again for these blocks
    return oldState;
  }

  protected override handleSwappedEvent(
    ev: SwappedEvent,
    oldState: DeepReadonly<MevCaptureV21PoolState.Object>,
  ): DeepReadonly<MevCaptureV21PoolState.Object> | null {
    return {
      ...oldState,
      ...ConcentratedPoolState.fromSwappedEvent(oldState, ev),
    };
  }
}
