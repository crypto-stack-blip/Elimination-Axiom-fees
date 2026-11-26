/**
 * tollfree — baseline decoding and fee-instrument classification.
 *
 * Input: a captured transaction in the shape of an RPC `getTransaction`
 * response (`transaction` as base64, plus `meta`), either fetched live or read
 * from a fixture. The decoder walks every instruction, resolves each program
 * against the registry, and classifies each instruction into the canonical
 * classes. Classification is deliberately conservative: anything not recognised
 * is `unknown` and is retained (and loudly reported) rather than dropped.
 */
import { Transaction } from '@solana/web3.js';
import { b58decode, b58encode, short58 } from './base58.js';
import { COMPUTE_BUDGET_PROGRAM, PUMP_AMM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, decodePumpAmmBuy, decodeRouterSwap, decodeTransferChecked, } from './programs.js';
function labelInstruction(programId, data) {
    if (programId === COMPUTE_BUDGET_PROGRAM)
        return { name: 'computeBudget', classificationHint: 'preflight' };
    if (programId === SYSTEM_PROGRAM)
        return { name: 'system', classificationHint: 'preflight' };
    if (programId === PUMP_AMM.program) {
        const buy = decodePumpAmmBuy(data);
        return { name: buy ? 'pumpAmm.buy' : 'pumpAmm.swap', classificationHint: 'swap' };
    }
    if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) {
        // Token instruction 12 = transferChecked; opcode 9 = closeAccount. The
        // opcode alone does not decide the class for transfers: transferChecked is
        // also the standard instrument of a fee charge, so the beneficiary
        // decides. See classifyTokenInstrument().
        if (data.length === 1 && data[0] === 9)
            return { name: 'closeAccount', classificationHint: 'housekeeping' };
        return { name: data.length === 13 && data[0] === 12 ? 'transferChecked' : 'token', classificationHint: null };
    }
    if (decodeRouterSwap(data))
        return { name: 'axiomRouter.swap', classificationHint: 'fee_wrapper' };
    return { name: 'unknown', classificationHint: 'unknown' };
}
/**
 * Classify a token-program instrument.
 *
 * transferChecked([source, mint, destination, authority]) is fee-shaped exactly
 * when the destination is NOT part of the settlement layer (a pool vault that
 * also appears in a swap instruction). Whether the MINT re-imposes the charge
 * through a token-2022 hook cannot be decided from the transaction alone; the
 * hook advisory is attached to the fee audit instead.
 */
function classifyTokenInstrument(ix, settlementAccounts) {
    const destination = ix.accounts[2];
    const source = ix.accounts[0];
    if (ix.name === 'transferChecked' && destination && source && !settlementAccounts.has(destination)) {
        ix.classification = 'fee_instrument';
        ix.beneficiary = destination;
        ix.payer = source;
        ix.note =
            'transferChecked to a non-settlement destination: fee-shaped. Advisory: confirm the mint carries no ' +
                'token-2022 transfer hook / transfer-fee extension; if it does, the charge is a mint property and ' +
                'no transaction-level rebuild can remove it.';
    }
    else {
        ix.classification = 'unknown';
    }
}
/**
 * The full account-key list in fee-payer-first order, mirroring how an RPC
 * getTransaction response orders accountKeys. Shared by the decoder and the
 * fixture generator so the two can never drift apart.
 */
export function collectAccountKeys(tx) {
    const keys = [];
    const push = (s) => {
        if (!keys.includes(s))
            keys.push(s);
    };
    for (const ix of tx.instructions) {
        for (const k of ix.keys)
            push(k.pubkey.toBase58());
        push(ix.programId.toBase58());
    }
    const feePayer = tx.feePayer?.toBase58() ?? keys[0];
    return [feePayer, ...keys.filter((k) => k !== feePayer)];
}
export function decodeBaseline(raw, fixtureLabel = 'inline') {
    const b64 = Array.isArray(raw.transaction) ? raw.transaction[0] : raw.transaction;
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    const accountKeys = collectAccountKeys(tx);
    const meta = raw.meta ?? {};
    const innerByOuter = new Map();
    for (const inner of meta.innerInstructions ?? []) {
        const views = [];
        for (const i of inner.instructions) {
            const labeled = labelInstruction(i.programId, b58decode(i.data));
            views.push({ venue: labeled.name, programId: i.programId, accounts: i.accounts, data: i.data });
        }
        innerByOuter.set(inner.index, views);
    }
    const instructions = tx.instructions.map((ix, idx) => {
        const dataRaw = new Uint8Array(ix.data);
        const labeled = labelInstruction(ix.programId.toBase58(), dataRaw);
        const innerSwap = (innerByOuter.get(idx) ?? []).find((v) => v.venue.startsWith('pumpAmm'));
        const decoded = {
            programId: ix.programId.toBase58(),
            name: labeled.name,
            keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
            accounts: ix.keys.map((k) => k.pubkey.toBase58()),
            data: b58encode(dataRaw),
            dataRaw,
            classification: labeled.classificationHint ?? 'unknown',
        };
        if (innerSwap)
            decoded.innerSwap = innerSwap;
        return decoded;
    });
    // Pass 1: everything except token-program instruments.
    for (const ix of instructions) {
        if (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM)
            continue;
        ix.classification = labelInstruction(ix.programId, ix.dataRaw ?? b58decode(ix.data)).classificationHint ?? 'unknown';
    }
    // Settlement account set = every account referenced by a swap or a wrapper.
    const settlementAccounts = new Set();
    for (const ix of instructions) {
        if (ix.classification === 'swap' || ix.classification === 'fee_wrapper') {
            for (const a of ix.accounts)
                settlementAccounts.add(a);
        }
    }
    // Pass 2: token-program instruments, now judged against the settlement set.
    for (const ix of instructions) {
        if (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) {
            classifyTokenInstrument(ix, settlementAccounts);
        }
    }
    const norm = (list) => (list ?? []).map((t) => ({ owner: t.owner, mint: t.mint, amount: Number(t.uiTokenAmount.amount) }));
    return {
        signature: raw.signature ?? `fixture:${fixtureLabel}`,
        slot: raw.slot ?? 0,
        blockTime: raw.blockTime,
        accountKeys,
        feePayer: accountKeys[0],
        recentBlockhash: tx.recentBlockhash ?? '',
        err: meta.err,
        fee: meta.fee ?? 5_000,
        preBalances: meta.preBalances ?? [],
        postBalances: meta.postBalances ?? [],
        preTokenBalances: norm(meta.preTokenBalances),
        postTokenBalances: norm(meta.postTokenBalances),
        logMessages: meta.logMessages ?? [],
        instructions,
    };
}
/** The inner settlement swap (if any) attached to a wrapper instruction. */
export function innerSwapOf(baseline, wrapperIndex) {
    return baseline.instructions[wrapperIndex]?.innerSwap ?? null;
}
/** Per-owner/mint deltas from the baseline meta, labelled by economic role. */
export function tokenDeltaMatrix(baseline, beneficiary) {
    const post = new Map(baseline.postTokenBalances.map((t) => [`${t.owner}:${t.mint}`, t]));
    const rows = [];
    for (const pre of baseline.preTokenBalances) {
        const p = post.get(`${pre.owner}:${pre.mint}`);
        if (!p)
            continue;
        const delta = p.amount - pre.amount;
        if (delta === 0)
            continue;
        const isPool = baseline.instructions
            .filter((ix) => ix.classification === 'swap' || ix.classification === 'fee_wrapper')
            .some((ix) => ix.accounts.includes(pre.owner));
        rows.push({
            owner: pre.owner,
            mint: pre.mint,
            delta,
            role: pre.owner === baseline.feePayer ? 'fee_payer' : pre.owner === beneficiary ? 'beneficiary' : isPool ? 'pool' : 'other',
        });
    }
    return rows;
}
/**
 * Audit the fee: infer the platform's take from balances first ("what actually
 * moved") and instruction evidence second ("why it moved").
 *
 * For a token-denominated instrument, the natural denominator is the
 * settlement layer's inflow of the same mint — i.e. the trade notional that
 * actually reached the pool — NOT the payer's gross outflow.
 */
export function auditFee(baseline) {
    const evidence = [];
    const archetypes = [];
    let platformBps = null;
    let beneficiary = null;
    const feeInstruments = baseline.instructions.filter((ix) => ix.classification === 'fee_instrument');
    const wrappers = baseline.instructions.filter((ix) => ix.classification === 'fee_wrapper');
    // --- Wrapper-skim inference (archetype B) ---------------------------------
    for (const w of wrappers) {
        const args = decodeRouterSwap(b58decode(w.data));
        if (args && args.feeBps > 0) {
            if (platformBps === null)
                platformBps = args.feeBps;
            archetypes.push('router_skim');
            evidence.push(`wrapper ${short58(w.programId)} declares fee_bps=${args.feeBps}; the settlement swap runs as a CPI (see inner instructions)`);
            if (w.accounts.length >= 9) {
                beneficiary = w.accounts[8]; // feeTreasury slot in the router layout
                evidence.push(`wrapper beneficiary (feeTreasury): ${short58(beneficiary)}`);
            }
        }
    }
    // --- Token-fee inference (archetype A) -------------------------------------
    const rows = tokenDeltaMatrix(baseline, null);
    for (const ix of feeInstruments) {
        const decoded = ix.dataRaw ? decodeTransferChecked(ix.dataRaw) : decodeTransferChecked(b58decode(ix.data));
        if (!decoded)
            continue;
        const mint = ix.accounts[1];
        const poolInflow = mint ? rows.find((r) => r.role === 'pool' && r.delta > 0 && r.mint === mint) : undefined;
        if (poolInflow && poolInflow.delta > 0) {
            const bps = Math.round((Number(decoded.amount) / poolInflow.delta) * 10_000);
            if (platformBps === null)
                platformBps = bps;
            archetypes.push('explicit_fee_transfer');
            beneficiary = ix.beneficiary ?? beneficiary;
            evidence.push(`fee instrument ${short58(ix.programId)} moves ${decoded.amount} raw of mint ${short58(mint)} to a non-settlement destination`);
            evidence.push(`inferred platform fee: ${decoded.amount} / pool inflow ${poolInflow.delta} => ${bps} bps`);
        }
        else {
            archetypes.push('explicit_fee_transfer');
            evidence.push(`fee instrument ${short58(ix.programId)} moves ${decoded.amount} raw of mint ${short58(ix.accounts[1] ?? '?')}; no matching pool inflow — bps not inferred`);
        }
    }
    const hookRisk = feeInstruments.length > 0
        ? 'fee-shaped transferChecked detected; confirm the mint carries no token-2022 transfer hook or transfer-fee extension before treating the instrument as removable'
        : undefined;
    if (archetypes.length === 0) {
        evidence.push('no fee-shaped instruction detected; the baseline may already be toll-free or use an unseen archetype');
    }
    return { platformBps, beneficiary, archetypes, lamportsFee: 0, mintDeltas: [], evidence, hookRisk };
}
