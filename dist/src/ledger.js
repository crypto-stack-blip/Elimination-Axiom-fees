/**
 * tollfree — fee accounting.
 *
 * This module exists to keep the project honest. A tool that claims to
 * "eliminate the fee" must also state precisely which costs it eliminates and
 * which costs it retains. Every number here is derived from the published AXIOM
 * schedule shape: a gross platform fee on every fill, a volume-tier cashback
 * paid in SOL, and separate settlement/network/execution costs that no terminal
 * controls.
 */
/** Published tier table shape (net fee = gross − cashback). */
export const AXIOM_TIERS = [
    { name: 'Wood', multiplier: 1, netFeeBps: 95, cashbackBps: 5 },
    { name: 'Bronze', multiplier: 2, netFeeBps: 90, cashbackBps: 10 },
    { name: 'Silver', multiplier: 2.5, netFeeBps: 87.5, cashbackBps: 12.5 },
    { name: 'Gold', multiplier: 3, netFeeBps: 85, cashbackBps: 15 },
    { name: 'Platinum', multiplier: 3.5, netFeeBps: 82.5, cashbackBps: 17.5 },
    { name: 'Diamond', multiplier: 4, netFeeBps: 80, cashbackBps: 20 },
    { name: 'Champion', multiplier: 5, netFeeBps: 75, cashbackBps: 25 },
];
export function defaultLedgerInput() {
    return {
        tradeSizeSol: 10,
        grossFeeBps: 100,
        cashbackBps: 25,
        networkFeeLamports: 5_000,
        priorityFeeLamports: 100_000,
        jitoTipLamports: 0,
        poolFeeBps: 25,
        mevLossBps: 10,
    };
}
function path(label, x, platformFeeActive, protectedByTerminal) {
    const sol = x.tradeSizeSol;
    const platformFee = platformFeeActive ? (sol * x.grossFeeBps) / 10_000 : 0;
    const cashback = platformFeeActive ? (sol * x.cashbackBps) / 10_000 : 0;
    const netPlatformFee = platformFee - cashback;
    const poolFee = (sol * x.poolFeeBps) / 10_000;
    const networkCost = (x.networkFeeLamports + x.priorityFeeLamports + x.jitoTipLamports) / 1e9;
    const mevCost = protectedByTerminal ? 0 : (sol * x.mevLossBps) / 10_000;
    const total = netPlatformFee + poolFee + networkCost + mevCost;
    return {
        label,
        platformFee,
        cashback,
        netPlatformFee,
        poolFee,
        networkCost,
        mevCost,
        total,
        bps: sol > 0 ? (total / sol) * 10_000 : 0,
    };
}
export function computeLedger(x) {
    const baseline = path('terminal-assembled (platform fee active)', x, true, true);
    const rebuilt = path('self-assembled (platform fee removed)', x, false, false);
    const savings = {
        absolute: baseline.total - rebuilt.total,
        bps: baseline.bps - rebuilt.bps,
        percentOfTrade: x.tradeSizeSol > 0 ? ((baseline.total - rebuilt.total) / x.tradeSizeSol) * 100 : 0,
    };
    // The rebuild loses terminal MEV protection; at some expected adverse-selection
    // cost it is no longer worth it. Break-even = the fee being removed.
    const mevBreakEvenBps = x.grossFeeBps - x.cashbackBps;
    const retained = [
        `settlement LP fee: ${x.poolFeeBps} bps — owned by the pool, charged on both paths`,
        'Solana network fee + priority fee — paid to the network on both paths',
        `expected MEV/adverse selection without terminal protection: ${x.mevLossBps} bps (parameter)`,
        'your own infrastructure: RPC, keypair custody, engineering time',
    ];
    return { baseline, rebuilt, savings, mevBreakEvenBps, retained };
}
/** What one trade of size S costs in the terminal, net of tier cashback. */
export function netFeeQuote(tradeSizeSol, tier) {
    const gross = (tradeSizeSol * 100) / 10_000;
    const cashback = (tradeSizeSol * tier.cashbackBps) / 10_000;
    return { gross, cashback, net: gross - cashback };
}
