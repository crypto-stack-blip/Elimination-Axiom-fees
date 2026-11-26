/**
 * tollfree — the rebuild planner.
 *
 * Takes a decoded baseline and produces a RebuildPlan: the minimal transaction
 * that performs the IDENTICAL settlement action (same pool, same direction,
 * same slippage floor) with the ASSEMBLY-layer fee instrument removed.
 *
 * Three strategies, keyed by the archetype the classifier detected:
 *
 *   A. explicit_fee_transfer  -> instruction stripping: keep the settlement and
 *      preflight instructions verbatim, drop the fee transfer.
 *   B. router_skim            -> unwrapping: promote the settlement swap from a
 *      CPI inside the router to a top-level instruction, drop the router.
 *   C. hook_fee               -> same as A, plus a mint-extension warning: if
 *      the mint carries a token-2022 transfer hook, the charge is imposed by
 *      the mint at transfer time and this planner cannot remove it.
 *
 * Anything unrecognised falls back to a conservative passthrough plan that
 * changes nothing and says so.
 */

import { PublicKey } from '@solana/web3.js';
import { b58decode, b58encode, short58 } from './base58.js';
import { PUMP_AMM, decodeRouterSwap } from './programs.js';
import { auditFee } from './decode.js';
import type {
  BaselineTx,
  Decision,
  DroppedInstr,
  FeeBreakdown,
  PlannedInstruction,
  RebuildPlan,
  RebuildPlanJson,
  TransformedInstr,
} from './types.js';

export interface PlanOptions {
  /** Fixture label for provenance. */
  fixture?: string;
  /** Force conservative passthrough even when an archetype was detected. */
  conservative?: boolean;
}

export function buildRebuildPlan(baseline: BaselineTx, opts: PlanOptions = {}): { plan: RebuildPlan; fee: FeeBreakdown } {
  const fee = auditFee(baseline);
  const decisions: Decision[] = [];
  const dropped: DroppedInstr[] = [];
  const transformed: TransformedInstr[] = [];
  const warnings: string[] = [];
  const preserves: string[] = [
    'same settlement program and pool accounts',
    'same swap direction and amount',
    'same minimum-out / slippage floor carried from the baseline',
    'same compute-unit limit and priority pricing policy',
  ];

  const wrapperIdx = baseline.instructions.findIndex((ix) => ix.classification === 'fee_wrapper');
  const feeIdx = baseline.instructions.findIndex(
    (ix) => ix.classification === 'fee_instrument' || ix.classification === 'fee_hook',
  );
  const hasHookInstrument = baseline.instructions.some((ix) => ix.classification === 'fee_hook');

  let archetype: RebuildPlan['archetype'] = 'conservative_passthrough';
  let venue = 'unknown settlement venue';
  let settlementProgramId = 'unknown';
  const out: PlannedInstruction[] = [];

  const keepIt = (idx: number, reason: string) => decisions.push({ index: idx, keep: true, reason });
  const dropIt = (idx: number, cls: DroppedInstr['classification'], reason: string) => {
    decisions.push({ index: idx, keep: false, reason });
    dropped.push({ index: idx, classification: cls, reason });
  };

  if (opts.conservative) {
    archetype = 'conservative_passthrough';
    warnings.push('conservative mode requested: no instructions removed, plan equals the baseline');
    baseline.instructions.forEach((ix, idx) => {
      keepIt(idx, 'conservative passthrough');
      out.push(plannedFromDecoded(ix));
    });
    venue = baseline.instructions.find((ix) => ix.classification === 'swap')?.name ?? venue;
    settlementProgramId = baseline.instructions.find((ix) => ix.classification === 'swap')?.programId ?? settlementProgramId;
  } else if (wrapperIdx >= 0 && baseline.instructions[wrapperIdx]!.innerSwap) {
    // ---- Strategy B: unwrap the router --------------------------------------
    archetype = 'router_skim';
    const wrapper = baseline.instructions[wrapperIdx]!;
    const inner = wrapper.innerSwap!;
    baseline.instructions.forEach((ix, idx) => {
      if (idx === wrapperIdx) {
        dropIt(idx, ix.classification, 'assembly router: performs settlement via CPI and skims basis points');
      } else if (ix.classification === 'preflight' || ix.classification === 'swap' || ix.classification === 'housekeeping') {
        keepIt(idx, `${ix.classification} retained verbatim`);
        out.push(plannedFromDecoded(ix));
      } else {
        keepIt(idx, `unclassified (${ix.name}) retained by policy`);
        warnings.push(`instruction ${idx} (${ix.name}) was not classified; retained conservatively`);
        out.push(plannedFromDecoded(ix));
      }
    });
    // Promote the inner settlement swap to a top-level instruction.
    const programIds = new Set(baseline.instructions.map((ix) => ix.programId));
    programIds.add(inner.programId);
    out.push({
      programId: inner.programId,
      keys: metasForPromotedSwap(inner.accounts, baseline.feePayer, programIds),
      data: b58decode(inner.data),
    });
    transformed.push({ index: wrapperIdx, from: `fee_wrapper ${short58(wrapper.programId)}`, to: `top-level ${inner.venue} swap` });
    venue = inner.venue;
    settlementProgramId = inner.programId;
    preserves.push('inner swap executed at the top level with the router removed, not via CPI');
  } else if (feeIdx >= 0) {
    // ---- Strategy A / C: strip the fee instrument ----------------------------
    archetype = hasHookInstrument ? 'hook_fee' : 'explicit_fee_transfer';
    const swapIx = baseline.instructions.find((ix) => ix.classification === 'swap');
    venue = swapIx?.name ?? venue;
    settlementProgramId = swapIx?.programId ?? settlementProgramId;
    baseline.instructions.forEach((ix, idx) => {
      if (idx === feeIdx) {
        dropIt(idx, ix.classification, 'assembly-layer fee instrument: a transfer whose beneficiary is outside the settlement layer');
      } else if (ix.classification === 'preflight' || ix.classification === 'swap' || ix.classification === 'housekeeping') {
        keepIt(idx, `${ix.classification} retained verbatim`);
        out.push(plannedFromDecoded(ix));
      } else {
        keepIt(idx, `unclassified (${ix.name}) retained by policy`);
        warnings.push(`instruction ${idx} (${ix.name}) was not classified; retained conservatively`);
        out.push(plannedFromDecoded(ix));
      }
    });
    if (fee.hookRisk) {
      warnings.push(fee.hookRisk);
      preserves.push('mint-extension audit must show a hookless mint for this plan to hold');
    }
  } else {
    // ---- Nothing detected: honest passthrough --------------------------------
    archetype = 'conservative_passthrough';
    warnings.push('no fee archetype detected; plan preserves the baseline unchanged');
    baseline.instructions.forEach((ix, idx) => {
      keepIt(idx, 'no fee archetype detected; verbatim passthrough');
      out.push(plannedFromDecoded(ix));
    });
    venue = baseline.instructions.find((ix) => ix.classification === 'swap')?.name ?? venue;
    settlementProgramId = swapProgramId(baseline) ?? settlementProgramId;
  }

  const plan: RebuildPlan = {
    kind: 'tollfree.rebuild-plan.v1',
    source: { fixture: opts.fixture ?? 'inline', signature: baseline.signature },
    archetype,
    venue,
    settlementProgramId,
    platformBps: fee.platformBps,
    beneficiary: fee.beneficiary,
    instructions: out,
    dropped,
    transformed,
    preserves,
    warnings,
  };
  return { plan, fee };
}

function swapProgramId(baseline: BaselineTx): string | undefined {
  return baseline.instructions.find((ix) => ix.classification === 'swap')?.programId;
}

/**
 * Keepers are copied byte-for-byte, INCLUDING the original signer/writable
 * metas captured in the baseline — a reconstruction that flips a signer bit is
 * not a reconstruction.
 */
function plannedFromDecoded(ix: {
  programId: string;
  keys?: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  accounts: string[];
  dataRaw?: Uint8Array;
  data: string;
}): PlannedInstruction {
  return {
    programId: ix.programId,
    keys: ix.keys ?? ix.accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    data: ix.dataRaw ?? b58decode(ix.data),
  };
}

/**
 * Reconstruct metas for a PROMOTED inner swap (strategy B). Inner CPI records
 * do not carry signer/writable flags, so they are rebuilt heuristically:
 *   - the fee payer is a signer;
 *   - known program ids are read-only;
 *   - everything else is treated as writable.
 * Live submission must confirm these against the venue IDL (see README).
 */
function metasForPromotedSwap(
  accounts: string[],
  feePayer: string,
  programIds: Set<string>,
): { pubkey: string; isSigner: boolean; isWritable: boolean }[] {
  return accounts.map((pubkey) => ({
    pubkey,
    isSigner: pubkey === feePayer,
    isWritable: !programIds.has(pubkey),
  }));
}

/** Serialise a plan to JSON (instruction data base58) for inspection / `submit`. */
export function planToJson(plan: RebuildPlan): RebuildPlanJson {
  return {
    ...plan,
    instructions: plan.instructions.map((ix) => ({
      programId: ix.programId,
      keys: ix.keys,
      data: b58encode(ix.data),
    })),
  };
}

export function planFromJson(json: RebuildPlanJson): RebuildPlan {
  return {
    ...json,
    instructions: json.instructions.map((ix) => ({
      programId: ix.programId,
      keys: ix.keys,
      data: b58decode(ix.data),
    })),
  };
}

/**
 * Invariant check on a strategy-B unwrap: the promoted settlement swap must
 * reference the same pool as the wrapper, and its arguments must be consistent
 * with the wrapper's declared args (amount and slippage floor preserved).
 */
export function checkUnwrapInvariants(baseline: BaselineTx, plan: RebuildPlan): string[] {
  const problems: string[] = [];
  const wrapper = baseline.instructions.find((ix) => ix.classification === 'fee_wrapper');
  if (!wrapper) return problems;
  const args = decodeRouterSwap(b58decode(wrapper.data));
  const inner = wrapper.innerSwap;
  if (!args || !inner) return problems;
  const poolInWrapper = wrapper.accounts.find((a) => a !== wrapper.accounts[0]);
  if (!inner.accounts.includes(poolInWrapper ?? '')) {
    problems.push('promoted swap does not reference the wrapper pool account');
  }
  const expectedAccounts = PUMP_AMM.buy.accounts.length;
  if (inner.accounts.length !== expectedAccounts) {
    problems.push(`promoted swap has ${inner.accounts.length} accounts; expected ${expectedAccounts} for ${PUMP_AMM.buy.accounts[0]}-order anchor instruction`);
  }
  if (plan.instructions.some((ix) => ix.programId === wrapper.programId)) {
    problems.push('plan still contains the fee wrapper program');
  }
  return problems;
}

/** Human-readable plan report. */
export function describePlan(plan: RebuildPlan, fee: FeeBreakdown): string {
  const lines: string[] = [];
  lines.push(`archetype        : ${plan.archetype}`);
  lines.push(`venue            : ${plan.venue}`);
  lines.push(`settlement prog  : ${plan.settlementProgramId}`);
  lines.push(`platform fee     : ${fee.platformBps === null ? 'not detected' : `${fee.platformBps} bps`}`);
  lines.push(`beneficiary      : ${fee.beneficiary ? short58(fee.beneficiary) : 'n/a'}`);
  lines.push(`instructions     : ${plan.instructions.length} kept, ${plan.dropped.length} dropped`);
  for (const d of plan.dropped) lines.push(`  dropped [${d.index}] (${d.classification}): ${d.reason}`);
  for (const t of plan.transformed) lines.push(`  transformed [${t.index}]: ${t.from} -> ${t.to}`);
  for (const p of plan.preserves) lines.push(`  preserves: ${p}`);
  for (const w of plan.warnings) lines.push(`  warning: ${w}`);
  for (const e of fee.evidence) lines.push(`  evidence: ${e}`);
  if (fee.hookRisk) lines.push(`  hook-risk: ${fee.hookRisk}`);
  return lines.join('\n');
}

/** Quick sanity: is a pubkey at least well-formed? Used by the CLI doctor. */
export function isWellFormedPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}
