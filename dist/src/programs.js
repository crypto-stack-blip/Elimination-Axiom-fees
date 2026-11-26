/**
 * tollfree — program registry and instruction layouts.
 *
 * Values here mirror the publicly documented, permissionless on-chain programs
 * that do the actual settlement work. The ASSEMBLY-layer programs (the
 * terminal's router / fee treasury) are fixture-scoped: their ids come from the
 * captured baseline, never hard-coded, because disintermediation means the tool
 * has no standing dependency on them.
 */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { b58decode, b58encode } from './base58.js';
/** Anchor-style 8-byte instruction discriminator: sha256("global:<name>")[0..8). */
export function anchorDiscriminator(ixName) {
    const h = createHash('sha256').update(`global:${ixName}`).digest();
    return new Uint8Array(h.subarray(0, 8));
}
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
/**
 * Pump.fun AMM (pumpswap) — an example of a SETTLEMENT program. Permissionless:
 * `buy` and `sell` are plain anchor instructions anyone can call against a pool.
 * The seeds below follow the program's published IDL layout.
 */
export const PUMP_AMM = {
    program: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    buy: {
        name: 'buy',
        disc: anchorDiscriminator('buy'),
        // anchor account order for global:buy
        accounts: [
            'pool',
            'user',
            'userBaseTokenAccount',
            'userQuoteTokenAccount',
            'poolBaseTokenAccount',
            'poolQuoteTokenAccount',
            'baseMint',
            'quoteMint',
            'feeRecipient',
            'systemProgram',
            'tokenBaseProgram',
            'tokenQuoteProgram',
            'eventAuthority',
            'program',
        ],
        // args: amount(u64 base tokens in) | maxQuoteAmount(u64 SOL ceiling)
    },
    sell: {
        name: 'sell',
        disc: anchorDiscriminator('sell'),
        accounts: [
            'pool',
            'user',
            'userBaseTokenAccount',
            'userQuoteTokenAccount',
            'poolBaseTokenAccount',
            'poolQuoteTokenAccount',
            'baseMint',
            'quoteMint',
            'feeRecipient',
            'systemProgram',
            'tokenBaseProgram',
            'tokenQuoteProgram',
            'eventAuthority',
            'program',
        ],
        // args: amount(u64 base tokens in) | minQuoteAmount(u64 SOL floor)
    },
    seeds: {
        pool: ['pool'],
        poolBaseTokenAccount: ['pool_token_a'],
        poolQuoteTokenAccount: ['pool_token_b'],
    },
};
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const pk = (s) => (typeof s === 'string' ? new PublicKey(s) : s);
/** Canonical associated-token-account derivation: [owner, tokenProgram, mint]. */
export function deriveAta(owner, mint, tokenProgram = TOKEN_PROGRAM) {
    return PublicKey.findProgramAddressSync([pk(owner).toBuffer(), pk(tokenProgram).toBuffer(), pk(mint).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58();
}
/** Pool PDA per the IDL seed table: ["pool", baseMint] (fixture-scoped derivation). */
export function derivePumpPool(baseMint) {
    return PublicKey.findProgramAddressSync([Buffer.from(PUMP_AMM.seeds.pool[0]), pk(baseMint).toBuffer()], new PublicKey(PUMP_AMM.program))[0].toBase58();
}
/** Anchor event-authority PDA ("__event_authority") used by anchor programs. */
export function pumpEventAuthority() {
    return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(PUMP_AMM.program))[0].toBase58();
}
/** Decode SPL transferChecked payload: [opcode 12 | amount u64 LE | decimals u8]. */
export function decodeTransferChecked(data) {
    if (data.length !== 13 || data[0] !== 12)
        return null;
    const buf = Buffer.from(data);
    return { amount: buf.readBigUInt64LE(1), decimals: buf[9] };
}
/** Derive the pool vault accounts from a pool address (IDL seeds). */
export function derivePumpAmmVaults(pool) {
    const [base] = PublicKey.findProgramAddressSync([Buffer.from(PUMP_AMM.seeds.poolBaseTokenAccount[0]), pool.toBuffer()], new PublicKey(PUMP_AMM.program));
    const [quote] = PublicKey.findProgramAddressSync([Buffer.from(PUMP_AMM.seeds.poolQuoteTokenAccount[0]), pool.toBuffer()], new PublicKey(PUMP_AMM.program));
    return { base, quote };
}
/**
 * Synthetic ASSEMBLY-layer router used by the fixtures and the demo. It models
 * the two observable behaviours of a fee-collecting router:
 *   - its instruction data carries the user's swap arguments AND a fee rate;
 *   - it CPIs into the real settlement program with the same swap arguments.
 *
 * Layout (little-endian):
 *   [0..8)   discriminator = sha256("global:axiom_router_swap")[0..8)
 *   [8..16)  amount        u64
 *   [16..24) min_out       u64
 *   [24..26) fee_bps       u16
 *   [26..34) expiry        u64
 */
export const AXIOM_ROUTER = {
    program: 'AxmR11oUTKQbCaXbMzb4YN3cWD4dTqFo4nMw3zHR6vk',
    disc: anchorDiscriminator('axiom_router_swap'),
    accounts: [
        'user',
        'userQuoteTokenAccount',
        'userBaseTokenAccount',
        'pool',
        'poolBaseTokenAccount',
        'poolQuoteTokenAccount',
        'baseMint',
        'quoteMint',
        'feeTreasury',
        'treasuryTokenAccount',
    ],
};
export function encodeRouterSwap(args) {
    const buf = Buffer.alloc(34);
    buf.set(AXIOM_ROUTER.disc, 0);
    buf.writeBigUInt64LE(args.amount, 8);
    buf.writeBigUInt64LE(args.minOut, 16);
    buf.writeUInt16LE(args.feeBps, 24);
    buf.writeBigUInt64LE(args.expiry, 26);
    return new Uint8Array(buf);
}
export function decodeRouterSwap(data) {
    if (data.length !== 34)
        return null;
    for (let i = 0; i < 8; i++)
        if (data[i] !== AXIOM_ROUTER.disc[i])
            return null;
    const buf = Buffer.from(data);
    return {
        amount: buf.readBigUInt64LE(8),
        minOut: buf.readBigUInt64LE(16),
        feeBps: buf.readUInt16LE(24),
        expiry: buf.readBigUInt64LE(26),
    };
}
/** pump.fun AMM buy args: [disc(8) | amount u64 | max_quote u64]. */
export function encodePumpAmmBuy(amount, maxQuote) {
    const buf = Buffer.alloc(24);
    buf.set(PUMP_AMM.buy.disc, 0);
    buf.writeBigUInt64LE(amount, 8);
    buf.writeBigUInt64LE(maxQuote, 16);
    return new Uint8Array(buf);
}
export function decodePumpAmmBuy(data) {
    if (data.length !== 24)
        return null;
    for (let i = 0; i < 8; i++)
        if (data[i] !== PUMP_AMM.buy.disc[i])
            return null;
    const buf = Buffer.from(data);
    return { amount: buf.readBigUInt64LE(8), maxQuote: buf.readBigUInt64LE(16) };
}
/** SPL token transferChecked args: [disc(8) | amount u64 | decimals u8]. */
export function encodeTransferChecked(amount, decimals) {
    const buf = Buffer.alloc(13);
    buf[0] = 12; // Instruction::TransferChecked discriminator in the token program ABI
    buf.writeBigUInt64LE(amount, 1);
    buf[9] = decimals;
    return new Uint8Array(buf);
}
export function isProgramId(s) {
    try {
        new PublicKey(b58decode(s));
        return b58encode(b58decode(s)) === s;
    }
    catch {
        return false;
    }
}
