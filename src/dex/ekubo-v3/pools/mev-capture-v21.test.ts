import vectorsJson from './fixtures/mev-capture-v21-vectors.json';
import anchorUpdatesJson from './fixtures/mev-capture-v21-anchor-updates.json';
import { MAX_TICK, MIN_TICK } from './math/tick';
import {
  CoreState,
  InitializedTick,
  isValidSqrtRatio,
  predSqrtRatio,
  sqrtRatioFromRaw,
  sqrtRatioToRaw,
  succSqrtRatio,
} from './math/mev-capture-v21';
import {
  mevCaptureV21GasCost,
  MevCaptureV21Anchor,
  MevCaptureV21Config,
  MevCaptureV21Model,
  MevCaptureV21PoolState,
  MevCaptureV21Simulator,
  quoteMevCaptureV21,
} from './mev-capture-v21';
import { ConcentratedPoolState } from './concentrated';
import { ConcentratedPoolTypeConfig, PoolConfig, PoolKey } from './utils';
import { encodeForwardedSwapRoute } from '../yul-router';

// Every Core call that the deployed extension makes for 21 swaps, traced with
// forge from `MEVCaptureV21` in EkuboProtocol/evm-contracts. The vectors carry
// the pool state but not the positions, which are those minted by the
// contract tests that produced them.
type Json = any;
const vectors: Json[] = (vectorsJson as Json).vectors;

const S = 4096;
const L66 = 1n << 66n;
const WIDE: [number, number, bigint] = [-40 * S, 40 * S, L66];
const POSITIONS: Record<string, [number, number, bigint][]> = {};
const layout = (names: string[], positions: [number, number, bigint][]) => {
  for (const name of names) POSITIONS[name] = positions;
};
layout(
  [
    'inc_exact_in_cut_bridge_rate',
    'dec_toward_then_away_exact_in',
    'inc_exact_out_after_anchor_update',
    'dec_exact_out_partial',
    'inc_exact_in_partial_mid_segment',
  ],
  [WIDE, [3 * S, 7 * S, L66], [-7 * S, -3 * S, L66]],
);
layout(
  [
    'exact_tick_state_dec_from_tick_T',
    'inc_through_T_toward_uncut',
    'dec_onto_T_tick_T_minus_1',
    'exact_tick_state_inc_from_tick_T_minus_1',
    'dec_onto_T_again',
    'fee_only_1_wei_exact_in_at_T',
  ],
  [WIDE, [3 * S, 7 * S, L66]],
);
layout(
  ['bridge_25pct_exact_in', 'bridge_25pct_exact_out_dec', 'bridge_1ulp_exact_in'],
  [WIDE, [2 * S, 3 * S, L66]],
);
layout(
  ['empty_words_skip0', 'return_toward_skip0', 'empty_words_skip3'],
  [
    [-S, S, L66],
    [1000 * S, 1001 * S, L66],
  ],
);
layout(
  ['cap_tail_to_max'],
  [
    [-20_000 * S, 20_000 * S, 1n << 40n],
    [3000 * S, 3001 * S, 1_000_000_000n],
  ],
);
layout(
  ['segexp2_offgrid_ticks_inc'],
  [WIDE, [3 * S, 7 * S, L66 * 2n], [8 * S, 9 * S, L66]],
);
layout(
  ['spacing3000_negative_anchor_dec', 'spacing3000_negative_anchor_inc'],
  [
    [-200 * 3000, 100 * 3000, L66],
    [-50 * 3000, -30 * 3000, L66],
  ],
);

function ticks(name: string): InitializedTick[] {
  const positions = POSITIONS[name];
  if (!positions) throw new Error(`no position layout for ${name}`);
  const net = new Map<number, bigint>();
  for (const [lo, hi, l] of positions) {
    net.set(lo, (net.get(lo) ?? 0n) + l);
    net.set(hi, (net.get(hi) ?? 0n) - l);
  }
  return [...net.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, liquidityDelta]) => ({ index, liquidityDelta }));
}

const coreState = (v: Json): CoreState => ({
  sqrtRatio: sqrtRatioFromRaw(BigInt(v.sqrtRatio)),
  tick: Number(v.tick),
  liquidity: BigInt(v.liquidity),
});

const vectorConfig = (c: Json): MevCaptureV21Config => ({
  halfLife: Number(c.tau),
  slopeK: Number(c.slopeK),
  segmentExp: Number(c.segExp),
  jLin: Number(c.jLin),
  maxFee: BigInt(c.maxFee),
  clampTicks: Number(c.clampTicks),
  mGate: Number(c.mGate),
});

const params = (v: Json) => ({
  isToken1: v.params.isToken1 as boolean,
  amount: BigInt(v.params.amount),
  sqrtRatioLimit: sqrtRatioFromRaw(BigInt(v.params.sqrtRatioLimit)),
  skipAhead: Number(v.params.skipAhead),
});

const simulator = (v: Json) =>
  new MevCaptureV21Simulator(
    vectorConfig(v.cfg),
    BigInt(v.pool.fee),
    Number(v.pool.tickSpacing),
    ticks(v.name),
  );

const vectorKey = (v: Json) =>
  new PoolKey(
    1n,
    2n,
    new PoolConfig(
      1n,
      BigInt(v.pool.fee),
      new ConcentratedPoolTypeConfig(Number(v.pool.tickSpacing)),
    ),
  );

// The pool state as the integration holds it after a full-range fetch
function poolState(v: Json, now: number): MevCaptureV21PoolState.Object {
  const core = coreState(v.before);
  const sortedTicks = [
    { number: MIN_TICK, liquidityDelta: 0n },
    ...ticks(v.name).map(t => ({
      number: t.index,
      liquidityDelta: t.liquidityDelta,
    })),
    { number: MAX_TICK, liquidityDelta: 0n },
  ];
  const state: MevCaptureV21PoolState.Object = {
    sqrtRatio: core.sqrtRatio,
    liquidity: core.liquidity,
    activeTick: core.tick,
    sortedTicks,
    activeTickIndex: null,
    checkedTicksBounds: [MIN_TICK, MAX_TICK],
    config: vectorConfig(v.cfg),
    // the vector's anchor, already updated for this timestamp
    anchor: {
      lastUpdateTime: now,
      lRefTime: now,
      lastPosTime: 0,
      lRefBits: 0,
      snapBits: 0,
      lRefRaiseTime: 0,
      anchorX16: BigInt(v.anchorX16),
    },
    blockTimestamp: now,
  };
  ConcentratedPoolState.addLiquidityCutoffs(state);
  return state;
}

describe('MEVCapture v2.1 contract vectors', () => {
  test('replay every Core call exactly', () => {
    expect(vectors.length).toBe(21);
    let callsChecked = 0;
    const coverage = { exactIn: 0, exactOut: 0, token0: 0, token1: 0, skip: 0 };

    for (const v of vectors) {
      const p = params(v);
      coverage[p.amount < 0n ? 'exactOut' : 'exactIn']++;
      coverage[p.isToken1 ? 'token1' : 'token0']++;
      if (p.skipAhead !== 0) coverage.skip++;

      const swap = simulator(v).swapThroughSegments(
        coreState(v.before),
        p,
        BigInt(v.anchorX16),
      );

      const actual = swap.calls.map(c => ({
        limit: sqrtRatioToRaw(c.sqrtRatioLimit),
        amount: c.amount,
        kind: c.kind.kind,
        surcharge: c.kind.kind === 'charged' ? c.kind.surcharge : 0n,
        before: c.stateBefore,
        after: c.stateAfter,
        delta0: c.delta0,
        delta1: c.delta1,
        fee0: c.surcharge0,
        fee1: c.surcharge1,
      }));
      const expected = (v.calls as Json[]).map(e => ({
        limit: BigInt(e.limit),
        amount: BigInt(e.amount),
        kind: e.kind,
        surcharge: BigInt(e.surcharge),
        before: coreState(e.before),
        after: coreState(e.after),
        delta0: BigInt(e.delta0),
        delta1: BigInt(e.delta1),
        fee0: BigInt(e.fee0),
        fee1: BigInt(e.fee1),
      }));
      expect({ name: v.name, calls: actual }).toEqual({
        name: v.name,
        calls: expected,
      });
      callsChecked += actual.length;

      expect({
        name: v.name,
        delta0: swap.delta0,
        delta1: swap.delta1,
        after: swap.coreStateAfter,
      }).toEqual({
        name: v.name,
        delta0: BigInt(v.total.delta0),
        delta1: BigInt(v.total.delta1),
        after: coreState(v.after),
      });
      expect(swap.resources.accumulateAsFees).toBe(
        (v.calls as Json[]).filter(e => BigInt(e.fee0) + BigInt(e.fee1) > 0n)
          .length,
      );
    }

    expect(callsChecked).toBe(266);
    for (const n of Object.values(coverage)) expect(n).toBeGreaterThan(0);
  });

  test('the integration quote equals every vector', () => {
    const now = 1_000;
    for (const v of vectors) {
      const p = params(v);
      const quote = quoteMevCaptureV21(
        vectorKey(v),
        p.amount,
        p.isToken1,
        poolState(v, now),
        now,
        p.sqrtRatioLimit,
        p.skipAhead,
      );
      const [specified, calculated] = p.isToken1
        ? [BigInt(v.total.delta1), BigInt(v.total.delta0)]
        : [BigInt(v.total.delta0), BigInt(v.total.delta1)];

      expect({
        name: v.name,
        consumed: quote.consumedAmount,
        calculated: quote.calculatedAmount,
        calls: quote.swap.calls.length,
      }).toEqual({
        name: v.name,
        consumed: specified,
        calculated: calculated < 0n ? -calculated : calculated,
        calls: v.calls.length,
      });
      expect(quote.swap.resources.anchorUpdates).toBe(0);
      expect(quote.gasConsumed).toBe(mevCaptureV21GasCost(quote.swap.resources));
    }
  });

  test('a quote stops at the range the state was fetched for', () => {
    const v = vectors.find(x => x.name === 'cap_tail_to_max');
    const state = poolState(v, 1);
    const high = 100 * S;
    const narrowed = {
      ...state,
      checkedTicksBounds: [MIN_TICK, high] as const,
      sortedTicks: [
        ...state.sortedTicks.filter(t => t.number < high),
        { number: high, liquidityDelta: 0n },
      ],
    };
    const amount = BigInt(v.params.amount);
    const full = quoteMevCaptureV21(vectorKey(v), amount, true, state, 1);
    const partial = quoteMevCaptureV21(vectorKey(v), amount, true, narrowed, 1);
    expect(full.swap.coreStateAfter.tick > high).toBe(true);
    expect(partial.consumedAmount < full.consumedAmount).toBe(true);
    expect(partial.swap.coreStateAfter.tick).toBe(high);
    // up to the range bound, the calls are those of the full quote
    const n = partial.swap.calls.length;
    expect(partial.swap.calls.slice(0, n - 1)).toEqual(
      full.swap.calls.slice(0, n - 1),
    );
  });

  test('a quote runs the anchor update of a new timestamp', () => {
    const v = vectors.find(x => x.name === 'inc_exact_in_cut_bridge_rate');
    const state = poolState(v, 1);
    const amount = 10n ** 18n;
    const same = quoteMevCaptureV21(vectorKey(v), amount, true, state, 1);
    const later = quoteMevCaptureV21(vectorKey(v), amount, true, state, 13);
    expect(same.swap.resources.anchorUpdates).toBe(0);
    expect(later.swap.resources.anchorUpdates).toBe(1);
    expect(later.swap.anchorAfter.lastUpdateTime).toBe(13);
    expect(later.gasConsumed).toBeGreaterThan(same.gasConsumed);
  });

  test('pred and succ cross regions', () => {
    for (const raw of [
      (1n << 94n) | (1n << 62n),
      (2n << 94n) | (1n << 62n),
      (3n << 94n) | (1n << 62n),
      1n << 63n,
    ]) {
      const x = sqrtRatioFromRaw(raw);
      expect(succSqrtRatio(predSqrtRatio(x))).toBe(x);
      expect(predSqrtRatio(x) < x).toBe(true);
      expect(isValidSqrtRatio(predSqrtRatio(x))).toBe(true);
      expect(succSqrtRatio(x) > x).toBe(true);
      expect(isValidSqrtRatio(succSqrtRatio(x))).toBe(true);
      expect(sqrtRatioToRaw(x)).toBe(raw);
    }
  });
});

const anchor = (v: Json): MevCaptureV21Anchor => ({
  lastUpdateTime: Number(v.lastUpdateTime),
  lRefTime: Number(v.lRefTime),
  lastPosTime: Number(v.lastPosTime),
  lRefBits: Number(v.lRefBits),
  snapBits: Number(v.snapBits),
  lRefRaiseTime: Number(v.lRefRaiseTime),
  anchorX16: BigInt(v.anchorX16),
});

describe('MEVCapture v2.1 anchor', () => {
  // The fixtures come from an earlier revision of the extension whose movement
  // allowance rounded down; the deployed one rounds it up, which moves the
  // anchor one more 2^-16 tick when the allowance is fractional and binding.
  test('anchor updates replay all seven fields', () => {
    const v = anchorUpdatesJson as Json;
    const c = v.config;
    const model = new MevCaptureV21Model({
      halfLife: Number(c.halfLife),
      slopeK: Number(c.slopeK),
      segmentExp: Number(c.segmentExp),
      jLin: Number(c.jLin),
      // the fixtures' fees are 0.16 numbers
      maxFee: BigInt(c.maxFee) << 48n,
      clampTicks: Number(c.clampTicks),
      mGate: Number(c.mGate),
    });
    expect(v.anchorUpdates.length).toBe(120);
    const halfLife = BigInt(model.config.halfLife);
    const clamp = BigInt(model.config.clampTicks);
    let roundedUp = 0;

    (v.anchorUpdates as Json[]).forEach((u, i) => {
      const stateIn = anchor(u.stateIn);
      const expected = anchor(u.expected);
      const now = Number(u.timestamp);
      const elapsed = BigInt((now - stateIn.lastUpdateTime) >>> 0);
      const dt = elapsed < halfLife ? elapsed : halfLife;
      const floored = ((clamp << 16n) * dt) / halfLife;
      const move = expected.anchorX16 - stateIn.anchorX16;
      if (
        u.passed &&
        ((clamp << 16n) * dt) % halfLife !== 0n &&
        (move < 0n ? -move : move) === floored
      ) {
        expected.anchorX16 += move < 0n ? -1n : 1n;
        roundedUp++;
      }

      const state = { ...stateIn };
      const gate = model.beforeSwap(
        state,
        Number(u.tick),
        BigInt(u.liquidity),
        now,
      );
      expect({ i, gate, state }).toEqual({
        i,
        gate: { passed: u.passed, lObs: Number(u.lObs), eRef: Number(u.eRef) },
        state: expected,
      });
    });

    expect(roundedUp).toBeGreaterThan(0);
  });

  const displaced = (): MevCaptureV21Anchor => ({
    lastUpdateTime: 0,
    lRefTime: 0,
    lastPosTime: 0,
    lRefBits: 0,
    snapBits: 0,
    lRefRaiseTime: 0,
    anchorX16: 0n,
  });

  test('frequent updates never slow the anchor', () => {
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    for (const halfLife of [1, 7, 120, 65_537]) {
      for (const clampTicks of [1, 2500]) {
        for (const n of [1, 17, 48]) {
          const model = new MevCaptureV21Model({
            halfLife,
            slopeK: 4,
            segmentExp: 0,
            jLin: 16,
            maxFee: 1n << 63n,
            clampTicks,
            mGate: 3,
          });
          const tick = 70 * clampTicks + 128;
          const units = BigInt(clampTicks) << 16n;
          const tau = BigInt(halfLife);
          const touched = displaced();
          for (let t = 1; t <= n; t++) model.beforeSwap(touched, tick, L66, t);
          expect(touched.anchorX16).toBe(BigInt(n) * ceilDiv(units, tau));
          const single = displaced();
          model.beforeSwap(single, tick, L66, n);
          expect(single.anchorX16).toBe(
            ceilDiv(units * (BigInt(n) < tau ? BigInt(n) : tau), tau),
          );
          expect(touched.anchorX16 >= single.anchorX16).toBe(true);
        }
      }
    }
  });
});

describe('Yul router route', () => {
  // `encodeRoutes` of @ekubo/yul-router-sdk 0.8.0 for the same route
  test('encodes a forwarded hop as the router SDK does', () => {
    const poolKey = {
      token0: '0x0000000000000000000000000000000000000000',
      token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      config:
        '0x51f831c23fa4051862881ef8efc0c3c37905ce490020c49ba5e353f7800003e8',
    };
    const route = (specifiedAmount: bigint) =>
      encodeForwardedSwapRoute({
        specifiedToken: 0n,
        calculatedToken: BigInt(poolKey.token1),
        specifiedAmount,
        recipient: '0x1111111111111111111111111111111111111111',
        poolKey,
        forwardee: '0x51f831c23fa4051862881ef8efc0c3c37905ce49',
        skipAhead: 0,
      });
    const hop =
      '0151f831c23fa4051862881ef8efc0c3c37905ce490000000000000000000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4851f831c23fa4051862881ef8efc0c3c37905ce490020c49ba5e353f7800003e800000000000000000000000080000000';
    const header =
      '0x01000000000000000000000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const recipient = '1111111111111111111111111111111111111111';
    expect(route(10n ** 18n)).toBe(
      header +
        '00000000000000000000000000000000' +
        recipient +
        '00000000000000000de0b6b3a7640000' +
        '00' +
        hop,
    );
    expect(route(-(10n ** 18n))).toBe(
      header +
        '80000000000000000000000000000000' +
        recipient +
        'fffffffffffffffff21f494c589c0000' +
        '00' +
        hop,
    );
  });
});
