/**
 * tollfree — test suite.
 *
 * The tests are the honesty layer: every claim the README makes about the
 * mechanism is asserted here against deterministic fixtures — classification,
 * inference, reconstruction equivalence, and the accounting math.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b58decode, b58encode } from '../src/base58.js';
import {
  AXIOM_ROUTER,
  PUMP_AMM,
  anchorDiscriminator,
  decodeTransferChecked,
  deriveAta,
  encodeTransferChecked,
  isProgramId,
} from '../src/programs.js';
import { auditFee, decodeBaseline, tokenDeltaMatrix } from '../src/decode.js';
import { buildRebuildPlan, checkUnwrapInvariants, planFromJson, planToJson } from '../src/rebuild.js';
import { verifyRebuild } from '../src/verify.js';
import { planToTransaction } from '../src/submit.js';
import { computeLedger, defaultLedgerInput } from '../src/ledger.js';
import { buildFixtures } from '../scripts/make-fixtures.js';
import type { RawTx } from '../src/decode.js';

function loadRaw(label: string): RawTx {
  return JSON.parse(readFileSync(join('.tmp-fixtures', `axiom-base-${label}.json`), 'utf8')) as RawTx;
}

// Generate fixtures once, into a fixed temp dir relative to the project root.
// (The dist copy runs from the project root, like `npm run demo`.)
import { mkdirSync, existsSync, rmSync } from 'node:fs';
if (!existsSync('.tmp-fixtures')) {
  mkdirSync('.tmp-fixtures', { recursive: true });
  buildFixtures('.tmp-fixtures');
}

test('base58 roundtrip, including leading zeros and empty input', () => {
  for (const bytes of [new Uint8Array(0), new Uint8Array([0, 0, 7]), new Uint8Array([255, 254, 253]), new Uint8Array(64).map((_, i) => i)]) {
    assert.deepEqual(Array.from(b58decode(b58encode(bytes))), Array.from(bytes));
  }
  assert.equal(b58encode(new Uint8Array([0, 0, 1])), '112');
});

test('anchor discriminator matches sha256("global:<name>")[0..8)', () => {
  const expected = new Uint8Array(createHash('sha256').update('global:buy').digest().subarray(0, 8));
  assert.deepEqual(Array.from(anchorDiscriminator('buy')), Array.from(expected));
});

test('pubkey helpers are well-formed and deterministic', () => {
  assert.equal(isProgramId(PUMP_AMM.program), true);
  assert.equal(isProgramId('not-a-pubkey'), false);
  const a1 = deriveAta('11111111111111111111111111111111', PUMP_AMM.program);
  const a2 = deriveAta('11111111111111111111111111111111', PUMP_AMM.program);
  assert.equal(a1, a2);
  assert.equal(isProgramId(a1), true);
});

test('transferChecked codec roundtrip', () => {
  const raw = encodeTransferChecked(10_000_000n, 9);
  assert.deepEqual(decodeTransferChecked(raw), { amount: 10_000_000n, decimals: 9 });
});

// ---------------------------------------------------------------------------
// Variant A — explicit fee transfer
// ---------------------------------------------------------------------------

const rawA = loadRaw('explicit-fee-transfer');
const baselineA = decodeBaseline(rawA, 'explicit-fee-transfer');

test('variant A: classification identifies the fee instrument', () => {
  const classes = baselineA.instructions.map((ix) => ix.classification);
  assert.equal(classes.filter((c) => c === 'swap').length, 1);
  assert.equal(classes.filter((c) => c === 'fee_instrument').length, 1);
  assert.equal(classes.filter((c) => c === 'preflight').length, 1);
  assert.equal(classes.includes('housekeeping'), true);

  const fee = auditFee(baselineA);
  assert.equal(fee.platformBps, 100);
  assert.ok(fee.archetypes.includes('explicit_fee_transfer'));
  assert.ok(fee.evidence.some((e) => e.includes('=> 100 bps')));
  assert.ok(fee.beneficiary !== null);
});

test('variant A: plan strips exactly the fee instrument', () => {
  const { plan } = buildRebuildPlan(baselineA, { fixture: 'explicit-fee-transfer' });
  assert.equal(plan.archetype, 'explicit_fee_transfer');
  assert.equal(plan.dropped.length, 1);
  assert.equal(plan.instructions.length, baselineA.instructions.length - 1);
  assert.equal(plan.platformBps, 100);
  const report = verifyRebuild(baselineA, plan);
  assert.equal(report.pass, true);
  assert.equal(report.feeRetainedRaw, 10_000_000);
  assert.ok(report.tokenDeltas.some((r) => r.role === 'fee_payer' && r.delta < 0));
  assert.ok(report.tokenDeltas.some((r) => r.role === 'pool' && r.delta > 0));
});

test('variant A: conservative mode changes nothing and says so', () => {
  const { plan } = buildRebuildPlan(baselineA, { conservative: true });
  assert.equal(plan.archetype, 'conservative_passthrough');
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.instructions.length, baselineA.instructions.length);
  const report = verifyRebuild(baselineA, plan);
  const droppedCheck = report.checks.find((c) => c.name === 'dropped_set_consistent');
  assert.equal(droppedCheck?.pass, true);
});

// ---------------------------------------------------------------------------
// Variant B — router skim (CPI unwrap)
// ---------------------------------------------------------------------------

const rawB = loadRaw('router-skim');
const baselineB = decodeBaseline(rawB, 'router-skim');

test('variant B: wrapper detected with inner settlement swap', () => {
  const wrapper = baselineB.instructions.find((ix) => ix.classification === 'fee_wrapper');
  assert.ok(wrapper, 'wrapper must be classified');
  assert.ok(wrapper!.innerSwap, 'inner settlement swap must be captured');
  assert.equal(wrapper!.innerSwap!.programId, PUMP_AMM.program);

  const fee = auditFee(baselineB);
  assert.equal(fee.platformBps, 100);
  assert.ok(fee.archetypes.includes('router_skim'));
});

test('variant B: unwrap produces a top-level settlement swap with the router gone', () => {
  const { plan } = buildRebuildPlan(baselineB, { fixture: 'router-skim' });
  assert.equal(plan.archetype, 'router_skim');
  assert.deepEqual(checkUnwrapInvariants(baselineB, plan), []);
  assert.equal(plan.instructions.some((ix) => ix.programId === AXIOM_ROUTER.program), false);
  assert.equal(plan.settlementProgramId, PUMP_AMM.program);

  const report = verifyRebuild(baselineB, plan);
  assert.equal(report.pass, true);
  const byteCheck = report.checks.find((c) => c.name === 'swap_data_byte_identical');
  assert.equal(byteCheck?.pass, true);
  assert.equal(report.feeRetainedRaw, 10_000_000);
});

test('variant B: promoted swap metas mark the fee payer as signer only', () => {
  const { plan } = buildRebuildPlan(baselineB, {});
  const promoted = plan.instructions.find((ix) => ix.programId === PUMP_AMM.program)!;
  const signers = promoted.keys.filter((key) => key.isSigner).map((key) => key.pubkey);
  assert.deepEqual(signers, [baselineB.feePayer]);
});

// ---------------------------------------------------------------------------
// Variant C — token-2022 fee surface
// ---------------------------------------------------------------------------

const rawC = loadRaw('hook-fee');
const baselineC = decodeBaseline(rawC, 'hook-fee');

test('variant C: same removal mechanics, plus the mint-extension advisory', () => {
  const { plan } = buildRebuildPlan(baselineC, { fixture: 'hook-fee' });
  assert.equal(plan.archetype, 'explicit_fee_transfer');
  assert.ok(plan.warnings.some((w) => w.includes('token-2022')), 'hook advisory must be present');
  assert.equal(plan.platformBps, 100);
  const report = verifyRebuild(baselineC, plan);
  assert.equal(report.pass, true);
  assert.equal(report.feeRetainedRaw, 10_000_000);
  assert.ok(report.checks.some((c) => c.name === 'mint_extension_audit' && !c.pass), 'mint audit stays open offline');
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

test('plan JSON roundtrip preserves instruction bytes', () => {
  const { plan } = buildRebuildPlan(baselineB, {});
  const json = planToJson(plan);
  const back = planFromJson(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(
    back.instructions.map((ix) => b58encode(ix.data)),
    plan.instructions.map((ix) => b58encode(ix.data)),
  );
  assert.deepEqual(back.dropped, plan.dropped);
});

test('plan converts to a web3.js transaction without throwing', () => {
  const { plan } = buildRebuildPlan(baselineA, {});
  const tx = planToTransaction(planToJson(plan), { feePayer: baselineA.feePayer, recentBlockhash: baselineA.recentBlockhash });
  assert.equal(tx.instructions.length, plan.instructions.length);
  assert.equal(
    tx.instructions.map((ix) => ix.programId.toBase58()).join(','),
    plan.instructions.map((ix) => ix.programId).join(','),
  );
});

test('token delta matrix labels roles correctly for variant A', () => {
  const rows = tokenDeltaMatrix(baselineA, auditFee(baselineA).beneficiary);
  const byRole = new Map(rows.map((r) => [r.role, r]));
  assert.ok(byRole.get('fee_payer'));
  assert.ok(byRole.get('pool'));
  assert.ok(byRole.get('beneficiary') || byRole.get('other'), 'treasury row is present');
});

test('ledger math: removing the fee is worth the net platform fee minus MEV exposure', () => {
  const input = defaultLedgerInput();
  const result = computeLedger(input);
  // baseline net platform fee: 10 SOL * (100-25)/10000 = 0.075
  assert.ok(Math.abs(result.baseline.netPlatformFee - 0.075) < 1e-9);
  // rebuilt pays zero platform fee but 10 bps expected MEV: 10 * 0.001 = 0.01
  assert.ok(Math.abs(result.rebuilt.mevCost - 0.01) < 1e-9);
  assert.ok(Math.abs(result.savings.absolute - 0.065) < 1e-9);
  assert.equal(result.mevBreakEvenBps, 75);
  // pool fee identical on both paths
  assert.equal(result.baseline.poolFee, result.rebuilt.poolFee);
});
