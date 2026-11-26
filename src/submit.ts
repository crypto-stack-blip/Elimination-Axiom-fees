/**
 * tollfree — submission path.
 *
 * Converts a rebuild plan into a signed transaction and hands it to YOUR RPC
 * endpoint over plain JSON-RPC. The terminal is no longer in the loop: it does
 * not build, sign, submit, or see this transaction.
 *
 * Default mode is simulation. Live submission is explicit and only runs after
 * simulation succeeds. The plan's signer/writable metas for promoted
 * (unwrapped) instructions are heuristic — see rebuild.ts — so live submission
 * requires confirming them against the venue IDL.
 */

import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { b58decode } from './base58.js';
import { isWellFormedPubkey } from './rebuild.js';
import type { RebuildPlanJson } from './types.js';

export interface SubmitResult {
  mode: 'simulated' | 'submitted';
  signature?: string;
  logs?: string[];
  unitsConsumed?: number;
  error?: string;
}

// ----------------------------------------------------------------- JSON-RPC

interface RpcError {
  code: number;
  message: string;
}

async function rpc<T = unknown>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status} for ${method}`);
  const body = (await res.json()) as { result?: T; error?: RpcError };
  if (body.error) throw new Error(`rpc error (${method}): ${body.error.message}`);
  return body.result as T;
}

/** Fresh recent blockhash fetch, isolated for testability. */
export async function fetchBlockhash(rpcUrl: string): Promise<string> {
  const result = await rpc<{ value: { blockhash: string } }>(rpcUrl, 'getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  return result.value.blockhash;
}

// ------------------------------------------------------------- transactions

/** Build a web3.js Transaction from a serialised plan. */
export function planToTransaction(
  plan: RebuildPlanJson,
  opts: { feePayer: string; recentBlockhash: string },
): Transaction {
  const tx = new Transaction({ feePayer: new PublicKey(opts.feePayer), recentBlockhash: opts.recentBlockhash });
  for (const ix of plan.instructions) {
    if (!isWellFormedPubkey(ix.programId)) throw new Error(`plan contains malformed program id: ${ix.programId}`);
    for (const k of ix.keys) {
      if (!isWellFormedPubkey(k.pubkey)) throw new Error(`plan contains malformed account: ${k.pubkey}`);
    }
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.keys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: Buffer.from(b58decode(ix.data)),
      }),
    );
  }
  return tx;
}

/** Load a keypair from a solana-keygen JSON array file or a base58 secret. */
export function loadKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(b58decode(trimmed));
}

// ---------------------------------------------------------------- execution

/**
 * Simulate, then optionally submit, a rebuild plan.
 * Simulation always runs first; live submission requires `live: true`.
 */
export async function executePlan(
  plan: RebuildPlanJson,
  opts: {
    rpcUrl: string;
    keypair: Keypair;
    recentBlockhash?: string;
    live: boolean;
  },
): Promise<SubmitResult> {
  const recentBlockhash = opts.recentBlockhash ?? (await fetchBlockhash(opts.rpcUrl));
  const tx = planToTransaction(plan, { feePayer: opts.keypair.publicKey.toBase58(), recentBlockhash });
  tx.sign(opts.keypair); // signs as fee payer; a well-formed plan has no other required signer
  const wire = tx.serialize().toString('base64');

  // --- Simulation gate -------------------------------------------------------
  const sim = await rpc<{
    value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
  }>(opts.rpcUrl, 'simulateTransaction', [
    wire,
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true },
  ]);
  if (sim.value.err) {
    return {
      mode: 'simulated',
      logs: sim.value.logs ?? [],
      error: `simulation failed: ${JSON.stringify(sim.value.err)}`,
    };
  }

  if (!opts.live) {
    return {
      mode: 'simulated',
      logs: sim.value.logs ?? [],
      unitsConsumed: sim.value.unitsConsumed,
    };
  }

  const signature = await rpc<string>(opts.rpcUrl, 'sendTransaction', [
    wire,
    { encoding: 'base64', skipPreflight: false },
  ]);
  return { mode: 'submitted', signature, logs: sim.value.logs ?? [] };
}

/** Guard: a plan that claims to drop a fee but drops nothing is refused. */
export function assertNoFeeWrapper(plan: RebuildPlanJson): void {
  if (plan.instructions.length === 0) throw new Error('empty plan');
  if (plan.archetype === 'explicit_fee_transfer' && plan.dropped.length === 0) {
    throw new Error('explicit_fee_transfer plan dropped nothing — refusing to submit');
  }
}
