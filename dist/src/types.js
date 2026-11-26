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
export {};
