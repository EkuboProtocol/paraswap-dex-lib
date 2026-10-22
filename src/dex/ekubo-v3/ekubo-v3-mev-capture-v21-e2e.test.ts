/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import { Interface } from '@ethersproject/abi';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { defaultAbiCoder, hexZeroPad, keccak256 } from 'ethers/lib/utils';
import { DeepReadonly } from 'ts-essentials';
import { LocalParaswapSDK } from '../../implementations/local-paraswap-sdk';
import { ContractMethod, Network, SwapSide } from '../../constants';
import { Token } from '../../types';
import { Tokens } from '../../../tests/constants-e2e';
import {
  CORE_ADDRESS,
  DEX_KEY,
  MEV_CAPTURE_V21_ADDRESS,
  YUL_ROUTER_ADDRESS,
} from './config';
import { EkuboV3PoolManager, EVENT_EMITTERS } from './ekubo-v3-pool-manager';
import {
  MevCaptureV21Pool,
  MevCaptureV21PoolState,
  quoteMevCaptureV21,
} from './pools/mev-capture-v21';
import { ConcentratedPoolTypeConfig, PoolConfig, PoolKey } from './pools/utils';
import { estimatedCurrentTime } from './pools/timed';
import { ekuboContracts } from './utils';

// End-to-end check of MEVCapture v2.1 pools against the deployed extension on
// a local fork of Ethereum, e.g.
//
//   anvil --fork-url <ethereum rpc> --port 8545
//   HTTP_PROVIDER_1=http://127.0.0.1:8545 EKUBO_V3_FORK_RPC_URL=http://127.0.0.1:8545 \
//     pnpm test src/dex/ekubo-v3/ekubo-v3-mev-capture-v21-e2e.test.ts
//
// The test creates and funds its own pool, prices swaps with the integration,
// executes them through Augustus, the executor and the Yul router
// (`Core.forward`), and requires each executed amount to equal the quote.
const FORK_RPC_URL = process.env.EKUBO_V3_FORK_RPC_URL;

const POSITIONS_ADDRESS = '0xa2971e0c37cfdb13ae8440a0c94ef1a1af39e326';
const AUGUSTUS_V6_ADDRESS = '0x6a000f20005980200259b80c5102003040001068';
const USDC_BALANCE_SLOT = 9;

// 0.3%, and 1000 ticks (about 0.1% in price) per surcharge segment
const FEE = 55340232221128654n;
const TICK_SPACING = 1000;
const BLOCK_TIME = 12;

const coreIface = new Interface([
  'function initializePool((address token0, address token1, bytes32 config) poolKey, int32 tick) returns (uint96)',
]);
const positionsIface = new Interface([
  'function mintAndDeposit((address token0, address token1, bytes32 config) poolKey, int32 tickLower, int32 tickUpper, uint128 maxAmount0, uint128 maxAmount1, uint128 minLiquidity) payable returns (uint256, uint128, uint128, uint128)',
]);
const erc20Iface = new Interface([
  'function approve(address, uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

jest.setTimeout(300 * 1000);

(FORK_RPC_URL ? describe : describe.skip)(
  'EkuboV3 MEVCapture v2.1 on an Ethereum fork',
  () => {
    const network = Network.MAINNET;
    const ETH = Tokens[network]['ETH'];
    const USDC = Tokens[network]['USDC'];

    const provider = new StaticJsonRpcProvider(FORK_RPC_URL, network);
    const poolKey = new PoolKey(
      0n,
      BigInt(USDC.address),
      new PoolConfig(
        BigInt(MEV_CAPTURE_V21_ADDRESS),
        FEE,
        new ConcentratedPoolTypeConfig(TICK_SPACING),
      ),
    );

    let user: string;
    let snapshot: string;
    let sdk: LocalParaswapSDK;
    let pool: MevCaptureV21Pool;
    let poolManager: EkuboV3PoolManager;

    async function send(to: string, data: string, value = 0n) {
      await provider.send('anvil_setNextBlockBaseFeePerGas', ['0x0']);
      const hash = await provider.send('eth_sendTransaction', [
        {
          from: user,
          to,
          data,
          value: '0x' + value.toString(16),
          gas: '0x' + (5_000_000).toString(16),
          maxFeePerGas: '0x0',
          maxPriorityFeePerGas: '0x0',
        },
      ]);
      return provider.waitForTransaction(hash);
    }

    async function balanceOf(token: Token): Promise<bigint> {
      if (token.address.toLowerCase() === ETH.address.toLowerCase()) {
        return (await provider.getBalance(user)).toBigInt();
      }
      return BigInt(
        await provider.call({
          to: token.address,
          data: erc20Iface.encodeFunctionData('balanceOf', [user]),
        }),
      );
    }

    // Feeds the logs of a block to the pool manager, as the block manager does
    async function processBlock(blockNumber: number) {
      const block = await provider.getBlock(blockNumber);
      const logs = (
        await Promise.all(
          EVENT_EMITTERS.map(address =>
            provider.getLogs({
              fromBlock: blockNumber,
              toBlock: blockNumber,
              address,
            }),
          ),
        )
      )
        .flat()
        .sort((a, b) => a.logIndex - b.logIndex);
      await poolManager.update(logs as any, { [blockNumber]: block as any });
      return logs;
    }

    beforeAll(async () => {
      snapshot = await provider.send('evm_snapshot', []);
      [user] = await provider.listAccounts();

      // Start at the price of the deployed ETH/USDC pilot pool
      const pilotKey = new PoolKey(
        0n,
        BigInt(USDC.address),
        new PoolConfig(
          BigInt(MEV_CAPTURE_V21_ADDRESS),
          9223372036854775n,
          new ConcentratedPoolTypeConfig(TICK_SPACING),
        ),
      );
      const pilotState = BigInt(
        await provider.getStorageAt(
          CORE_ADDRESS,
          hexZeroPad('0x' + pilotKey.numId.toString(16), 32),
        ),
      );
      const marketTick = Number(BigInt.asIntN(32, pilotState >> 128n));
      const center = Math.floor(marketTick / TICK_SPACING) * TICK_SPACING;

      await provider.send('anvil_setStorageAt', [
        USDC.address,
        keccak256(
          defaultAbiCoder.encode(
            ['address', 'uint256'],
            [user, USDC_BALANCE_SLOT],
          ),
        ),
        hexZeroPad('0x' + (10n ** 13n).toString(16), 32),
      ]);
      for (const spender of [POSITIONS_ADDRESS, AUGUSTUS_V6_ADDRESS]) {
        await send(
          USDC.address,
          erc20Iface.encodeFunctionData('approve', [spender, 2n ** 255n]),
        );
      }

      const initialized = await send(
        CORE_ADDRESS,
        coreIface.encodeFunctionData('initializePool', [
          poolKey.toAbi(),
          center,
        ]),
      );
      expect(initialized.status).toBe(1);

      const s = TICK_SPACING;
      for (const [lower, upper, amount0, amount1] of [
        [center - 20 * s, center + 20 * s, 20n * 10n ** 18n, 80_000n * 10n ** 6n],
        [center + 3 * s, center + 4 * s, 2n * 10n ** 18n, 0n],
        [center - 4 * s, center - 3 * s, 0n, 8_000n * 10n ** 6n],
      ] as const) {
        const minted = await send(
          POSITIONS_ADDRESS,
          positionsIface.encodeFunctionData('mintAndDeposit', [
            poolKey.toAbi(),
            lower,
            upper,
            amount0,
            amount1,
            0,
          ]),
          amount0,
        );
        expect(minted.status).toBe(1);
      }

      // Blocks ahead of the clock, so that a quote is priced at the next block
      const { timestamp } = await provider.getBlock('latest');
      await provider.send('evm_setNextBlockTimestamp', [
        Math.max(timestamp, Math.floor(Date.now() / 1000)) + 3600,
      ]);
      await provider.send('evm_mine', []);

      sdk = new LocalParaswapSDK(network, DEX_KEY, FORK_RPC_URL!);
      poolManager = (sdk.dexAdapterService.getDexByKey(DEX_KEY) as any)
        .poolManager;
      pool = new MevCaptureV21Pool(
        DEX_KEY,
        sdk.dexHelper,
        sdk.dexHelper.getLogger(DEX_KEY),
        ekuboContracts(sdk.dexHelper.provider),
        0,
        poolKey,
      );
      const blockNumber = await provider.getBlockNumber();
      pool.setState(await pool.generateState(blockNumber), blockNumber);
      poolManager.setPool(pool);
    });

    afterAll(async () => {
      await sdk?.releaseResources();
      if (snapshot) await provider.send('evm_revert', [snapshot]);
    });

    async function swap(
      srcToken: Token,
      destToken: Token,
      amount: bigint,
      side: SwapSide,
    ) {
      const blockNumber = await provider.getBlockNumber();
      const state = pool.getState(blockNumber);
      expect(state).not.toBeNull();
      const now = Number(
        estimatedCurrentTime(BigInt(state!.blockTimestamp), network),
      );
      expect(now).toBe(state!.blockTimestamp + BLOCK_TIME);

      const priceRoute = await sdk.getPrices(
        srcToken,
        destToken,
        amount,
        side,
        side === SwapSide.SELL
          ? ContractMethod.swapExactAmountIn
          : ContractMethod.swapExactAmountOut,
        { [DEX_KEY]: [poolKey.stringId] },
      );
      const srcAmount = BigInt(priceRoute.srcAmount);
      const destAmount = BigInt(priceRoute.destAmount);

      const specifiedToken = side === SwapSide.SELL ? srcToken : destToken;
      const quote = quoteMevCaptureV21(
        poolKey,
        side === SwapSide.SELL ? amount : -amount,
        specifiedToken.address.toLowerCase() === USDC.address.toLowerCase(),
        state as DeepReadonly<MevCaptureV21PoolState.Object>,
        now,
      );
      expect(quote.calculatedAmount).toBe(
        side === SwapSide.SELL ? destAmount : srcAmount,
      );

      const tx = await sdk.buildTransaction(
        priceRoute,
        side === SwapSide.SELL ? destAmount : srcAmount,
        user,
      );

      const before = [await balanceOf(srcToken), await balanceOf(destToken)];
      await provider.send('evm_setNextBlockTimestamp', [now]);
      const receipt = await send(tx.to, tx.data, BigInt(tx.value ?? '0'));
      const spent = before[0] - (await balanceOf(srcToken));
      const received = (await balanceOf(destToken)) - before[1];

      const trace = await provider.send('debug_traceTransaction', [
        receipt.transactionHash,
        { tracer: 'callTracer' },
      ]);
      let forwards = 0;
      let routerGas = 0;
      const walk = (frame: any) => {
        const to = (frame.to ?? '').toLowerCase();
        if (to === YUL_ROUTER_ADDRESS.toLowerCase() && frame.type === 'CALL')
          routerGas += parseInt(frame.gasUsed, 16);
        if (to === MEV_CAPTURE_V21_ADDRESS.toLowerCase()) forwards++;
        for (const call of frame.calls ?? []) walk(call);
      };
      walk(trace);

      console.log(
        JSON.stringify({
          side,
          src: srcToken.symbol,
          amount: amount.toString(),
          status: receipt.status,
          quoted: [srcAmount.toString(), destAmount.toString()],
          executed: [spent.toString(), received.toString()],
          calls: quote.swap.calls.map(c => c.kind.kind),
          anchorUpdate: quote.swap.resources.anchorUpdates,
          gasEstimate: quote.gasConsumed,
          routerGas,
          error: receipt.status === 1 ? undefined : trace.error,
        }),
      );

      expect(receipt.status).toBe(1);
      expect(forwards).toBe(1);
      expect(spent).toBe(srcAmount);
      expect(received).toBe(destAmount);

      // The state after the block's logs is the state read from the chain
      const logs = await processBlock(receipt.blockNumber);
      expect(logs.length).toBeGreaterThan(0);
      expect(pool.getState(receipt.blockNumber)).toEqual(
        await pool.generateState(receipt.blockNumber),
      );

      return { quote, routerGas };
    }

    const kinds = (q: { swap: { calls: { kind: { kind: string } }[] } }) =>
      q.swap.calls.map(c => c.kind.kind);

    test('SELL USDC -> ETH away from the anchor, in several charged calls', async () => {
      const { quote } = await swap(
        USDC,
        ETH,
        20_000n * 10n ** 6n,
        SwapSide.SELL,
      );
      expect(kinds(quote)).not.toContain('toward');
      expect(
        kinds(quote).filter(k => k === 'charged').length,
      ).toBeGreaterThan(1);
    });

    test('SELL ETH -> USDC toward the anchor, then away from it', async () => {
      const { quote } = await swap(ETH, USDC, 10n * 10n ** 18n, SwapSide.SELL);
      expect(kinds(quote)[0]).toBe('toward');
      expect(
        kinds(quote).filter(k => k === 'charged').length,
      ).toBeGreaterThan(1);
    });

    test('SELL USDC -> ETH toward the anchor only', async () => {
      const { quote } = await swap(USDC, ETH, 1_000n * 10n ** 6n, SwapSide.SELL);
      expect(kinds(quote)).toEqual(['toward']);
    });

    test('BUY ETH with USDC', async () => {
      await swap(USDC, ETH, 3n * 10n ** 18n, SwapSide.BUY);
    });

    test('BUY USDC with ETH', async () => {
      await swap(ETH, USDC, 10_000n * 10n ** 6n, SwapSide.BUY);
    });
  },
);
