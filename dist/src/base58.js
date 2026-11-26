/**
 * Minimal Base58 codec (Bitcoin alphabet, as used by Solana).
 * Self-contained so the tool has zero dependencies beyond @solana/web3.js.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = {};
for (let i = 0; i < ALPHABET.length; i++)
    MAP[ALPHABET[i]] = i;
export function b58encode(bytes) {
    if (bytes.length === 0)
        return '';
    // Count leading zeros.
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0)
        zeros++;
    // Convert base 256 -> base 58.
    const digits = [];
    for (let i = zeros; i < bytes.length; i++) {
        let carry = bytes[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let out = '';
    for (let i = 0; i < zeros; i++)
        out += ALPHABET[0];
    for (let i = digits.length - 1; i >= 0; i--)
        out += ALPHABET[digits[i]];
    return out;
}
export function b58decode(str) {
    if (str.length === 0)
        return new Uint8Array(0);
    let zeros = 0;
    while (zeros < str.length && str[zeros] === ALPHABET[0])
        zeros++;
    const bytes = [];
    for (let i = zeros; i < str.length; i++) {
        const value = MAP[str[i]];
        if (value === undefined)
            throw new Error(`invalid base58 character at ${i}: ${str[i]}`);
        let carry = value;
        for (let j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    const out = new Uint8Array(zeros + bytes.length);
    for (let i = 0; i < zeros; i++)
        out[i] = 0;
    for (let i = 0; i < bytes.length; i++)
        out[zeros + i] = bytes[bytes.length - 1 - i];
    return out;
}
/** Shorten a long base58 string for log output: first 4 + … + last 4. */
export function short58(s) {
    return s.length <= 12 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}
