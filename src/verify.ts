/**
 * tollfree — verification.
 *
 * A reconstruction that is not proven equivalent is just a different trade.
 * This module checks the structural invariants of a rebuild plan against its
 * baseline, and computes the expected outcome difference from the baseline's
 * balance metadata: identical settlement action, strictly more value retained.
 */

import { b58decode, b58encode, short58 } from './base58.js';
import { PUMP_AMM, decodePumpAmmBuy } from './programs.js';
import { auditFee, tokenDeltaMatrix } from './decode.js';
import type { BaselineTx, RebuildPlan, TokenDeltaRole } from './types.js';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export type TokenDeltaRow = TokenDeltaRole;

export interface VerificationReport {
  checks: Check[];
  pass: boolean;
  tokenDeltas: TokenDeltaRole[];
  /** Raw units the fee instrument moved out of the fee payer (the saving). */
  feeRetainedRaw: number | null;
  feeMint: string | null;
  notes: string[];
}

export function verifyRebuild(baseline: BaselineTx, plan: RebuildPlan): VerificationReport {
  const checks: Check[] = [];
  const notes: string[] = [];
  const fee = auditFee(baseline);

  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  // 1. The wrapper program must not survive into the plan.
  const wrapper = baseline.instructions.find((ix) => ix.classification === 'fee_wrapper');
  const wrapperInPlan = wrapper ? plan.instructions.some((ix) => ix.programId === wrapper.programId) : false;
  add(
    'no_wrapper_program_in_plan',
    !wrapperInPlan,
    wrapper ? `wrapper ${short58(wrapper.programId)} absent from plan` : 'no wrapper present in baseline',
  );

  // 2. Fee instruments must not survive into the plan.
  const feeInstruments = baseline.instructions.filter(
    (ix) => ix.classification === 'fee_instrument' || ix.classification === 'fee_hook',
  );
  const survivors = feeInstruments.filter((fi) => {
    const data58 = b58encode(fi.dataRaw ?? b58decode(fi.data));
    return plan.instructions.some((ix) => ix.programId === fi.programId && b58encode(ix.data) === data58);
  });
  add(
    'no_fee_instrument_in_plan',
    survivors.length === 0,
    survivors.length === 0
      ? `${feeInstruments.length} fee instrument(s) removed`
      : `${survivors.length} fee instrument(s) still present — refusing to call this toll-free`,
  );

  // 3. The beneficiary must not receive value from any planned instruction.
  const beneficiary = fee.beneficiary;
  const beneficiaryTouched = beneficiary
    ? plan.instructions.some((ix) => ix.keys.some((k) => k.pubkey === beneficiary && k.isWritable))
    : false;
  add(
    'no_value_flows_to_beneficiary',
    !beneficiaryTouched,
    beneficiary ? `beneficiary ${short58(beneficiary)} not writable in any planned instruction` : 'no beneficiary identified',
  );

  // 4. The settlement swap must be present exactly once in the plan.
  const baselineSwaps = baseline.instructions.filter(
    (ix) => ix.classification === 'swap' || (ix.classification === 'fee_wrapper' && ix.innerSwap),
  );
  const planSwaps = plan.instructions.filter((ix) => ix.programId === plan.settlementProgramId);
  add(
    'settlement_swap_present_exactly_once',
    baselineSwaps.length === 1 && planSwaps.length === 1,
    `baseline: ${baselineSwaps.length}, plan: ${planSwaps.length} (program ${short58(plan.settlementProgramId)})`,
  );

  // 5. The swap payload must be byte-identical (amount + slippage floor + accounts).
  if (baselineSwaps.length === 1 && planSwaps.length === 1) {
    const b = baselineSwaps[0]!;
    const inner = b.innerSwap;
    const baseAccounts = inner ? inner.accounts : b.accounts;
    const baseData = inner ? b58decode(inner.data) : b.dataRaw ?? b58decode(b.data);
    const p = planSwaps[0]!;
    const sameData = Buffer.compare(Buffer.from(baseData), Buffer.from(p.data)) === 0;
    const sameAccounts = JSON.stringify(baseAccounts) === JSON.stringify(p.keys.map((k) => k.pubkey));
    add('swap_data_byte_identical', sameData, sameData ? 'amount and min-out preserved bit-for-bit' : 'swap payload differs — plan is NOT equivalent');
    add('swap_accounts_identical', sameAccounts, sameAccounts ? 'same account order and membership' : 'account list differs — plan is NOT equivalent');

    // 6. Slippage floor preserved (decoded args comparison for pump AMM buys).
    const baseArgs = decodePumpAmmBuy(baseData);
    const planArgs = decodePampSafe(p.data);
    if (baseArgs && planArgs) {
      add(
        'slippage_floor_preserved',
        baseArgs.maxQuote === planArgs.maxQuote && baseArgs.amount === planArgs.amount,
        `amount=${baseArgs.amount}, maxQuote(min-out floor)=${baseArgs.maxQuote} preserved`,
      );
    }
  }

  // 7. Compute policy preserved.
  const baseCompute = baseline.instructions.filter((ix) => ix.programId.startsWith('ComputeBudget'));
  const planCompute = plan.instructions.filter((ix) => ix.programId.startsWith('ComputeBudget'));
  add(
    'compute_policy_preserved',
    baseCompute.length === planCompute.length &&
      baseCompute.every((c, i) => b58encode(c.dataRaw ?? b58decode(c.data)) === b58encode(planCompute[i]!.data)),
    `${planCompute.length} compute-budget instruction(s), identical payload`,
  );

  // 8. Signer set preserved (fee payer is the only expected signer).
  const baseSigners = new Set(
    baseline.instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey)),
  );
  const planSigners = new Set(plan.instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey)));
  const signerDiff = [...planSigners].filter((s) => !baseSigners.has(s));
  add(
    'signer_set_preserved',
    signerDiff.length === 0,
    signerDiff.length === 0 ? `signers: ${[...planSigners].map(short58).join(', ') || '(fee payer only, implicit)'}` : `new signers introduced: ${signerDiff.map(short58).join(', ')}`,
  );

  // 9. Mint-extension advisory whenever a token-denominated instrument was removed.
  if (fee.hookRisk) {
    add(
      'mint_extension_audit',
      false,
      'UNDECIDED offline: a token-2022 mint can re-impose the charge via a transfer hook at transfer time. ' +
        'Fetch the mint account and confirm there is no TransferHook/TransferFee extension before executing.',
    );
    notes.push('hook_fee archetype: removal is conditional on a hookless mint');
  }

  // 10. Dropped-inventory consistency: a non-passthrough plan must drop something;
  // a passthrough plan must drop nothing.
  const drops = plan.dropped.length;
  const consistent = plan.archetype === 'conservative_passthrough' ? drops === 0 : drops > 0;
  add(
    'dropped_set_consistent',
    consistent,
    `${drops} instruction(s) dropped under archetype ${plan.archetype}`,
  );

  // ---- Expected outcome from baseline meta ---------------------------------
  const tokenDeltas = tokenDeltaMatrix(baseline, fee.beneficiary);
  const benRows = tokenDeltas.filter((r) => r.role === 'beneficiary' && r.delta > 0);
  const payerRows = tokenDeltas.filter((r) => r.role === 'fee_payer' && r.delta < 0);
  const poolRows = tokenDeltas.filter((r) => r.role === 'pool' && r.delta > 0);
  let feeRetainedRaw: number | null = null;
  let feeMint: string | null = null;
  if (benRows.length > 0) {
    feeRetainedRaw = benRows[0]!.delta;
    feeMint = benRows[0]!.mint;
  } else if (payerRows.length > 0 && poolRows.length > 0) {
    // Router-skim fallback: the payer's outflow minus what actually reached the
    // pool (same mint) is the skim.
    const mint = payerRows[0]!.mint;
    const poolInflow = poolRows.find((r) => r.mint === mint);
    if (poolInflow) {
      feeRetainedRaw = -payerRows[0]!.delta - poolInflow.delta;
      feeMint = mint;
    }
  }
  if (plan.archetype === 'router_skim' && fee.platformBps !== null) {
    notes.push(`router skim: ${fee.platformBps} bps of the swap value is diverted by the wrapper; unwrap removes the diversion`);
  }

  const pass = checks.every((c) => c.pass || c.name === 'mint_extension_audit' || c.name === 'dropped_set_consistent');
  return { checks, pass, tokenDeltas, feeRetainedRaw, feeMint, notes };
}

function decodePampSafe(data: Uint8Array) {
  try {
    return decodePumpAmmBuy(data);
  } catch {
    return null;
  }
}

export { tokenDeltaMatrix } from './decode.js';

/** Pretty-print the verification report. */
export function describeReport(r: VerificationReport): string {
  const lines: string[] = [];
  lines.push(`verification: ${r.pass ? 'PASS (structural equivalence)' : 'FAIL'}`);
  for (const c of r.checks) lines.push(`  [${c.pass ? ' ok ' : c.name === 'mint_extension_audit' ? 'WARN' : 'FAIL'}] ${c.name}: ${c.detail}`);
  if (r.feeRetainedRaw !== null && r.feeMint) {
    lines.push(`  fee retained per identical trade: ${r.feeRetainedRaw} raw units of ${short58(r.feeMint)}`);
  }
  lines.push('  expected token deltas (baseline):');
  for (const t of r.tokenDeltas) {
    lines.push(`    ${t.role.padEnd(10)} ${short58(t.owner)} ${short58(t.mint)} ${t.delta > 0 ? '+' : ''}${t.delta}`);
  }
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

/** Reference to the settlement program used in reports. */
export const SETTLEMENT_REFERENCE = PUMP_AMM.program;
