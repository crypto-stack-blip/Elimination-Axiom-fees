/**
 * tollfree — shared types.
 *
 * The vocabulary is deliberately organised into three planes:
 *
 *   SETTLEMENT   AMM pools / bonding curves. Permissionless programs. Anyone may
 *                call their swap instruction; they charge an LP fee, never a
 *                platform fee, and they do not know or care who is calling.
 *
 *   ASSEMBLY     The terminal's transaction-assembly layer: route selection,
 *                instruction construction, fee insertion, submission. This is
 *                the layer that charges the AXIOM-style platform fee.
 *
 *   PRESENTATION UI, charts, discovery, wallet tracking. Monetised indirectly.
 *
 * Everything in this codebase follows from one observation: the platform fee is
 * levied at the ASSEMBLY layer, and assembly is a client-side activity. What is
 * assembled from permissionless parts can be reassembled without the toll.
 */

/** Classification of an instruction found in a captured baseline transaction. */
export type InstrClass =
  /** The settlement-layer swap itself. Must survive reconstruction unchanged. */
  | 'swap'
  /** ATA creation / account warm-up. Re-derivable; retained when needed. */
  | 'preflight'
  /** The platform's explicit fee instruction (a transfer to its treasury). Removed. */
  | 'fee_instrument'
  /** A router program that performs the swap AND skims basis points. Unwrapped. */
  | 'fee_wrapper'
  /** Account closing / rent reclaim. User choice; never load-bearing for the swap. */
  | 'housekeeping'
  /** A token-2022-style hook transfer imposed as a fee. Removed if the mint has no hook. */
  | 'fee_hook'
  /** Anything not recognised. Conservatively retained and reported. */
  | 'unknown'
  /** Internal convenience CPI of the wrapper program. Removed with the wrapper. */
  | 'cpi_internal';

export interface DecodedInstruction {
  /** Base58 program id. */
  programId: string;
  /** Original account metas (signer/writable flags), preserved verbatim for keepers. */
  keys: PlannedKey[];
  /** Human label, e.g. "buy", "transferChecked", "computeBudget". */
  name: string;
  /** Base58 account pubkeys, in order. */
  accounts: string[];
  /** Instruction data, base58-encoded. */
  data: string;
  /** Raw instruction data as bytes (not present in serialised JSON plans). */
  dataRaw?: Uint8Array;
  classification: InstrClass;
  /** For fee instruments: the account charged. */
  payer?: string;
  /** For fee instruments: the account paid (the platform treasury). */
  beneficiary?: string;
  /** For fee_wrapper: the settlement swap hidden inside the CPI. */
  innerSwap?: InnerSwapView;
  /** Number of lamports/tokens the instrument moves, if derivable from the meta. */
  movedLamports?: number;
  movedMint?: string;
  movedMintDelta?: number;
  note?: string;
}

export interface InnerSwapView {
  venue: string;
  programId: string;
  accounts: string[];
  data: string;
}

export interface Decision {
  index: number;
  keep: boolean;
  reason: string;
}

/**
 * A captured baseline: the transaction as the terminal assembled it, plus the
 * RPC metadata (balances, inner instructions) needed to audit it.
 */
export interface BaselineTx {
  signature: string;
  slot: number;
  blockTime?: number;
  /** All account keys, outer list first (legacy transactions only). */
  accountKeys: string[];
  feePayer: string;
  recentBlockhash: string;
  err?: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  logMessages: string[];
  instructions: DecodedInstruction[];
}

export interface TokenBalance {
  owner: string;
  mint: string;
  amount: number;
  programId?: string;
}

/** A per-owner/mint delta labelled by its economic role in the trade. */
export interface TokenDeltaRole {
  owner: string;
  mint: string;
  delta: number;
  role: 'fee_payer' | 'beneficiary' | 'pool' | 'other';
}

export interface FeeBreakdown {
  /** Basis points diverted to a non-venue beneficiary, or null if not detected. */
  platformBps: number | null;
  beneficiary: string | null;
  /** Archetypes detected, e.g. ["explicit_fee_transfer", "router_skim"]. */
  archetypes: string[];
  /** Lamports attributable to the platform fee in the baseline tx. */
  lamportsFee: number;
  /** Token deltas attributable to the platform fee (mint -> delta). */
  mintDeltas: { mint: string; delta: number }[];
  /** Human-readable evidence trail. */
  evidence: string[];
  /** Whether the mint used carries a token-2022 hook that could re-impose fees. */
  hookRisk?: string;
}

export interface PlannedKey {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

/* PlannedKey is declared early because DecodedInstruction references it. */

export interface PlannedInstruction {
  programId: string;
  keys: PlannedKey[];
  data: Uint8Array;
}

export interface DroppedInstr {
  index: number;
  classification: InstrClass;
  reason: string;
}

export interface TransformedInstr {
  index: number;
  from: string;
  to: string;
}

export interface RebuildPlan {
  kind: 'tollfree.rebuild-plan.v1';
  source: { fixture: string; signature: string };
  archetype: 'explicit_fee_transfer' | 'router_skim' | 'hook_fee' | 'conservative_passthrough';
  venue: string;
  settlementProgramId: string;
  platformBps: number | null;
  beneficiary: string | null;
  instructions: PlannedInstruction[];
  dropped: DroppedInstr[];
  transformed: TransformedInstr[];
  preserves: string[];
  warnings: string[];
}

/** A serialisable form of the plan (instruction data as base58). */
export interface RebuildPlanJson extends Omit<RebuildPlan, 'instructions'> {
  instructions: {
    programId: string;
    keys: PlannedKey[];
    data: string;
  }[];
}

export interface LedgerInput {
  /** Trade size in SOL. */
  tradeSizeSol: number;
  /** Platform gross fee in bps (AXIOM publishes 100 = 1%). */
  grossFeeBps: number;
  /** Tier cashback in bps (0.05%..0.25% => 5..25). */
  cashbackBps: number;
  /** Solana base network fee per tx, lamports. */
  networkFeeLamports: number;
  /** Priority fee per tx, lamports. */
  priorityFeeLamports: number;
  /** Optional Jito tip, lamports. */
  jitoTipLamports: number;
  /** Settlement-layer LP fee in bps (identical on both paths). */
  poolFeeBps: number;
  /** Expected adverse-selection cost WITHOUT terminal MEV protection, bps. */
  mevLossBps: number;
}

export interface LedgerPath {
  label: string;
  platformFee: number;
  cashback: number;
  netPlatformFee: number;
  poolFee: number;
  networkCost: number;
  mevCost: number;
  total: number;
  /** All-in cost as basis points of trade size. */
  bps: number;
}

export interface LedgerResult {
  baseline: LedgerPath;
  rebuilt: LedgerPath;
  savings: { absolute: number; bps: number; percentOfTrade: number };
  /** MEV loss (bps) at which the rebuilt path stops being cheaper. */
  mevBreakEvenBps: number;
  retained: string[];
}
