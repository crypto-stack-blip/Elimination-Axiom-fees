/**
 * tollfree — fixture generator.
 *
 * Builds three self-contained, deterministic baseline captures in the shape of
 * RPC `getTransaction` responses. Each fixture is a REAL, serialisable Solana
 * transaction (signed by a throwaway deterministic keypair) plus RPC metadata,
 * modelling the three observable fee archetypes a terminal can emit:
 *
 *   A. axiom-base-explicit-fee-transfer.json — the platform fee is a standalone
 *      SPL transferChecked from the user's quote account to the treasury.
 *   B. axiom-base-router-skim.json — the platform fee is hidden inside an
 *      assembly router that CPIs the settlement program and skims basis points.
 *   C. axiom-base-hook-fee.json — the fee transfer runs through the token-2022
 *      program (a hook-capable mint), which changes the audit questions, not
 *      the removal mechanics.
 *
 * Balance metadata is internally consistent: every delta the decoder audits is
 * present and arithmetically correct.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction, } from '@solana/web3.js';
import { b58encode } from '../src/base58.js';
import { AXIOM_ROUTER, PUMP_AMM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, deriveAta, derivePumpAmmVaults, derivePumpPool, encodePumpAmmBuy, encodeRouterSwap, encodeTransferChecked, pumpEventAuthority, } from '../src/programs.js';
const keypair = (label) => Keypair.fromSeed(createHash('sha256').update(label).digest());
const pub = (label) => keypair(label).publicKey;
const k = (p, isSigner, isWritable) => ({
    pubkey: typeof p === 'string' ? new PublicKey(p) : p,
    isSigner,
    isWritable,
});
const RENT_TOKEN_ACCOUNT = 2_039_280;
const RENT_MINT = 1_640_000;
const NETWORK_FEE = 5_000;
const SLOT = 319_214_871;
const BLOCK_TIME = 1_764_133_806;
export function buildFixtures(outDir) {
    mkdirSync(outDir, { recursive: true });
    // ---- Shared economic constants of the modelled trade ----------------------
    const TRADE_BASE = 5000000n; // 5.000000 MEME (6 dp) bought
    const QUOTE_SPENT = 1000000000n; // 1.000000000 quote (9 dp) into the pool
    const LP_FEE_ADJUSTED_OUT = 4987500n; // base out after the pool's own 25 bps LP fee
    const PLATFORM_FEE_QUOTE = 10000000n; // 1% of notional, diverted to the treasury
    const user = keypair('tollfree/user/1');
    const treasury = keypair('tollfree/treasury/1');
    const baseMint = pub('tollfree/mint/base');
    const quote2022Mint = pub('tollfree/mint/quote-2022');
    const WSOL = new PublicKey(WSOL_MINT);
    const pool = new PublicKey(derivePumpPool(baseMint));
    const { base: poolBaseVault, quote: poolQuoteVault } = derivePumpAmmVaults(pool);
    const eventAuthority = new PublicKey(pumpEventAuthority());
    const poolFeeRecipient = pub('tollfree/pool-fee/1');
    const tempAccount = pub('tollfree/temp/1');
    const userBaseATA = new PublicKey(deriveAta(user.publicKey, baseMint));
    const userWsolATA = new PublicKey(deriveAta(user.publicKey, WSOL));
    const userQ2022ATA = new PublicKey(deriveAta(user.publicKey, quote2022Mint, TOKEN_2022_PROGRAM));
    const treasuryWsolATA = new PublicKey(deriveAta(treasury.publicKey, WSOL));
    const treasuryBaseATA = new PublicKey(deriveAta(treasury.publicKey, baseMint));
    const treasuryQ2022ATA = new PublicKey(deriveAta(treasury.publicKey, quote2022Mint, TOKEN_2022_PROGRAM));
    // The settlement buy is parameterised over the quote leg so variant C can
    // trade the token-2022 quote mint while variants A/B trade canonical WSOL.
    const buyKeys = (quoteATA, quoteMint, quoteTokenProgram) => [
        k(pool, false, true),
        k(user.publicKey, true, true),
        k(userBaseATA, false, true),
        k(quoteATA, false, true),
        k(poolBaseVault, false, true),
        k(poolQuoteVault, false, true),
        k(baseMint, false, false),
        k(quoteMint, false, false),
        k(poolFeeRecipient, false, true), // LP fee recipient — pool-owned, NOT the platform treasury
        k(new PublicKey(SYSTEM_PROGRAM), false, false),
        k(new PublicKey(TOKEN_PROGRAM), false, false), // base token program
        k(new PublicKey(quoteTokenProgram), false, false), // quote token program
        k(eventAuthority, false, false),
        k(new PublicKey(PUMP_AMM.program), false, false),
    ];
    const buyAccounts58 = (quoteATA, quoteMint, quoteTokenProgram) => buyKeys(quoteATA, quoteMint, quoteTokenProgram).map((m) => m.pubkey.toBase58());
    const buyIx = (quoteATA, quoteMint, quoteTokenProgram) => new TransactionInstruction({
        programId: new PublicKey(PUMP_AMM.program),
        keys: buyKeys(quoteATA, quoteMint, quoteTokenProgram),
        data: Buffer.from(encodePumpAmmBuy(TRADE_BASE, QUOTE_SPENT + (QUOTE_SPENT * 25n) / 10000n)),
    });
    // ---- Variant A -------------------------------------------------------------
    const txA = new Transaction({ feePayer: user.publicKey, recentBlockhash: b58encode(createHash('sha256').update('tollfree/A/bh').digest()) });
    txA.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 120_000 }));
    txA.add(buyIx(userWsolATA, WSOL, TOKEN_PROGRAM));
    txA.add(new TransactionInstruction({
        programId: new PublicKey(TOKEN_PROGRAM),
        keys: [k(userWsolATA, false, true), k(WSOL, false, false), k(treasuryWsolATA, false, true), k(user.publicKey, true, true)],
        data: Buffer.from(encodeTransferChecked(PLATFORM_FEE_QUOTE, 9)),
    }));
    txA.add(new TransactionInstruction({
        programId: new PublicKey(TOKEN_PROGRAM),
        keys: [k(tempAccount, false, true), k(user.publicKey, false, true), k(user.publicKey, true, true)],
        data: Buffer.from([9]), // closeAccount
    }));
    txA.sign(user);
    // ---- Variant B -------------------------------------------------------------
    const routerKeys = [
        k(user.publicKey, true, true),
        k(userWsolATA, false, true),
        k(userBaseATA, false, true),
        k(pool, false, true),
        k(poolBaseVault, false, true),
        k(poolQuoteVault, false, true),
        k(baseMint, false, false),
        k(WSOL, false, false),
        k(treasury.publicKey, false, true), // feeTreasury (owner)
        k(treasuryWsolATA, false, true), // treasury token account
    ];
    const txB = new Transaction({ feePayer: user.publicKey, recentBlockhash: b58encode(createHash('sha256').update('tollfree/B/bh').digest()) });
    txB.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 120_000 }));
    txB.add(new TransactionInstruction({
        programId: new PublicKey(AXIOM_ROUTER.program),
        keys: routerKeys,
        data: Buffer.from(encodeRouterSwap({ amount: TRADE_BASE, minOut: 4900000n, feeBps: 100, expiry: BigInt(SLOT + 150) })),
    }));
    txB.sign(user);
    // ---- Variant C -------------------------------------------------------------
    const q22 = new PublicKey(TOKEN_2022_PROGRAM);
    const txC = new Transaction({ feePayer: user.publicKey, recentBlockhash: b58encode(createHash('sha256').update('tollfree/C/bh').digest()) });
    txC.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 120_000 }));
    txC.add(buyIx(userQ2022ATA, quote2022Mint, TOKEN_2022_PROGRAM));
    txC.add(new TransactionInstruction({
        programId: q22,
        keys: [k(userQ2022ATA, false, true), k(quote2022Mint, false, false), k(treasuryQ2022ATA, false, true), k(user.publicKey, true, true)],
        data: Buffer.from(encodeTransferChecked(PLATFORM_FEE_QUOTE, 9)),
    }));
    txC.sign(user);
    // ---- Shared meta scaffolding ----------------------------------------------
    const signatureOf = (tag) => b58encode(createHash('sha256').update(`tollfree/sig/${tag}`).digest());
    const lamports = new Map();
    const setL = (p, v) => lamports.set(p.toBase58(), v);
    setL(user.publicKey, 5_000_000_000);
    setL(pool, 1_000_000);
    for (const acct of [userBaseATA, userWsolATA, userQ2022ATA, poolBaseVault, poolQuoteVault, treasuryWsolATA, treasuryBaseATA, treasuryQ2022ATA]) {
        setL(acct, RENT_TOKEN_ACCOUNT);
    }
    setL(baseMint, RENT_MINT);
    setL(quote2022Mint, RENT_MINT);
    setL(poolFeeRecipient, 1_000_000);
    setL(tempAccount, 561_672);
    // Accept Keypair / PublicKey / string uniformly for owner and mint columns.
    const addrOf = (x) => x instanceof PublicKey ? x.toBase58() : typeof x === 'string' ? x : x.publicKey.toBase58();
    const tokenRows = (rows) => ({
        pre: rows.map((r) => ({ owner: addrOf(r.owner), mint: addrOf(r.mint), uiTokenAmount: { amount: r.pre } })),
        post: rows.map((r) => ({ owner: addrOf(r.owner), mint: addrOf(r.mint), uiTokenAmount: { amount: r.post } })),
    });
    const finalize = (tag, tx, description, archetype, note, extra) => {
        // Account keys with the exact walk decodeBaseline uses.
        const keys = [];
        const push = (s) => {
            if (!keys.includes(s))
                keys.push(s);
        };
        for (const ix of tx.instructions) {
            for (const m of ix.keys)
                push(m.pubkey.toBase58());
            push(ix.programId.toBase58());
        }
        const feePayer = tx.feePayer.toBase58();
        const accountKeys = [feePayer, ...keys.filter((x) => x !== feePayer)];
        const preBalances = accountKeys.map((key) => lamports.get(key) ?? 0);
        const postBalances = accountKeys.map((key) => extra.postLamports ? extra.postLamports(lamports.get(key) ?? 0, key) : (lamports.get(key) ?? 0));
        const { pre, post } = tokenRows(extra.tokenRows);
        const fixture = {
            label: tag,
            description,
            annotations: { archetype, note },
            signature: signatureOf(tag),
            slot: SLOT,
            blockTime: BLOCK_TIME,
            transaction: [tx.serialize().toString('base64')],
            meta: {
                err: null,
                fee: NETWORK_FEE,
                preBalances,
                postBalances,
                preTokenBalances: pre,
                postTokenBalances: post,
                innerInstructions: extra.inner ?? [],
                logMessages: extra.logs,
            },
        };
        const file = join(outDir, `axiom-base-${tag}.json`);
        writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
        return fixture;
    };
    const baseLamportAdjust = (key) => (key === user.publicKey.toBase58() ? -NETWORK_FEE : 0);
    // Variant A meta: fee payer pays network fee and receives closed rent back.
    finalize('explicit-fee-transfer', txA, 'Terminal-assembled buy with the platform fee as a standalone SPL transferChecked to the treasury. ' +
        'The settlement swap (pump.fun AMM buy) is directly callable; the fee instruction is not part of settlement.', 'explicit_fee_transfer', 'quote leg is canonical WSOL; fee instrument is a plain SPL transfer', {
        postLamports: (b, key) => {
            if (key === user.publicKey.toBase58())
                return b - NETWORK_FEE + 561_672; // rent reclaimed from closed account
            if (key === tempAccount.toBase58())
                return 0; // account closed
            return b + baseLamportAdjust(key);
        },
        tokenRows: [
            { owner: user, mint: WSOL, pre: '2000000000', post: '990000000' }, // 2 - 1.01
            { owner: user, mint: baseMint, pre: '0', post: LP_FEE_ADJUSTED_OUT.toString() },
            { owner: pool, mint: WSOL, pre: '12500000000000', post: '12501000000000' }, // +1e9
            { owner: pool, mint: baseMint, pre: '800000000000', post: '799995012500' }, // -4,987,500
            { owner: treasury, mint: WSOL, pre: '100000000000', post: '100010000000' }, // +0.01e9
        ],
        logs: [
            `Program ${'ComputeBudget111111111111111111111111111111'} invoke [1]`,
            'Program ComputeBudget111111111111111111111111111111 success',
            `Program ${PUMP_AMM.program} invoke [1]`,
            'Program log: Route: pumpswap buy',
            `Program log: Swap: amount_in=${QUOTE_SPENT} base_out=${LP_FEE_ADJUSTED_OUT} lp_fee_bps=25`,
            `Program ${PUMP_AMM.program} success`,
            `Program ${TOKEN_PROGRAM} invoke [1]`,
            `Program log: TransferChecked: ${PLATFORM_FEE_QUOTE} of ${WSOL_MINT}`,
            `Program ${TOKEN_PROGRAM} success`,
            `Program ${TOKEN_PROGRAM} invoke [1]`,
            `Program ${TOKEN_PROGRAM} success`,
        ],
    });
    // Variant B meta: same economics, fee hidden in the wrapper's skim.
    finalize('router-skim', txB, 'Terminal-assembled buy routed through the assembly router. The router CPIs the settlement program ' +
        'with the user\u2019s arguments, then diverts fee_bps of the quote leg to its treasury. The settlement ' +
        'instruction is visible in the inner-instruction trace and is directly callable.', 'router_skim', 'fee is declared in router args (fee_bps=100) and executed post-CPI', {
        postLamports: (b, key) => b + baseLamportAdjust(key),
        tokenRows: [
            { owner: user, mint: WSOL, pre: '2000000000', post: '990000000' },
            { owner: user, mint: baseMint, pre: '0', post: LP_FEE_ADJUSTED_OUT.toString() },
            { owner: pool, mint: WSOL, pre: '12500000000000', post: '13500000000000' },
            { owner: pool, mint: baseMint, pre: '800000000000', post: '799995012500' },
            { owner: treasury, mint: WSOL, pre: '100000000000', post: '100010000000' },
        ],
        inner: [
            {
                index: 1,
                instructions: [
                    {
                        programId: PUMP_AMM.program,
                        accounts: buyAccounts58(userWsolATA, WSOL, TOKEN_PROGRAM),
                        data: b58encode(encodePumpAmmBuy(TRADE_BASE, QUOTE_SPENT + (QUOTE_SPENT * 25n) / 10000n)),
                    },
                ],
            },
        ],
        logs: [
            'Program ComputeBudget111111111111111111111111111111 invoke [1]',
            'Program ComputeBudget111111111111111111111111111111 success',
            `Program ${AXIOM_ROUTER.program} invoke [1]`,
            'Program log: axiom-router: route=pumpswap fee_bps=100',
            `Program ${PUMP_AMM.program} invoke [1]`,
            `Program log: Swap: amount_in=${QUOTE_SPENT} base_out=${LP_FEE_ADJUSTED_OUT} lp_fee_bps=25`,
            `Program ${PUMP_AMM.program} success`,
            `Program log: skim: ${PLATFORM_FEE_QUOTE} -> fee_treasury`,
            `Program ${AXIOM_ROUTER.program} success`,
        ],
    });
    // Variant C meta: same economics; the fee transfer runs through token-2022.
    finalize('hook-fee', txC, 'Terminal-assembled buy on a token-2022 quote mint. The fee instrument is a transferChecked under the ' +
        'token-2022 program. Transaction-level mechanics are identical to variant A; the open question is ' +
        'whether the mint itself carries a transfer-fee/hook extension, which would re-impose the charge on ' +
        'any transfer, including a rebuilt one.', 'hook_fee_surface', 'fee instrument runs under the token-2022 program; mint extension audit required', {
        postLamports: (b, key) => b + baseLamportAdjust(key),
        tokenRows: [
            { owner: user, mint: quote2022Mint, pre: '2000000000', post: '990000000' },
            { owner: user, mint: baseMint, pre: '0', post: LP_FEE_ADJUSTED_OUT.toString() },
            { owner: pool, mint: quote2022Mint, pre: '12500000000000', post: '12501000000000' },
            { owner: pool, mint: baseMint, pre: '800000000000', post: '799995012500' },
            { owner: treasury, mint: quote2022Mint, pre: '100000000000', post: '100010000000' },
        ],
        logs: [
            'Program ComputeBudget111111111111111111111111111111 invoke [1]',
            'Program ComputeBudget111111111111111111111111111111 success',
            `Program ${PUMP_AMM.program} invoke [1]`,
            'Program log: Route: pumpswap buy',
            `Program log: Swap: amount_in=${QUOTE_SPENT} base_out=${LP_FEE_ADJUSTED_OUT} lp_fee_bps=25`,
            `Program ${PUMP_AMM.program} success`,
            `Program ${TOKEN_2022_PROGRAM} invoke [1]`,
            `Program log: TransferChecked: ${PLATFORM_FEE_QUOTE} of ${quote2022Mint}`,
            'Program log: TransferFee context: mint extension audit required before removal',
            `Program ${TOKEN_2022_PROGRAM} success`,
        ],
    });
    return ['explicit-fee-transfer', 'router-skim', 'hook-fee'].map((t) => join(outDir, `axiom-base-${t}.json`));
}
// CLI entry: regenerate the committed fixtures.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('make-fixtures.js')) {
    const outDir = process.argv[2] ?? 'fixtures';
    const files = buildFixtures(outDir);
    console.log(`wrote ${files.length} fixtures:`);
    for (const f of files)
        console.log(`  ${f}`);
}
