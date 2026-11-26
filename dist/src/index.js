#!/usr/bin/env node
/**
 * tollfree — command-line interface.
 *
 *   tollfree demo                 reconstruct every shipped fixture, end to end
 *   tollfree decode --file <f>    decode + classify a captured baseline
 *   tollfree plan --file <f>      produce a rebuild plan (optionally --out json)
 *   tollfree verify --file <f>    verify a plan against its baseline
 *   tollfree fees --size <sol>    the honest accounting of what is saved
 *   tollfree submit --file <p> --keypair <kp> --rpc <url> [--live]
 *   tollfree fixtures [dir]       regenerate the deterministic fixtures
 *   tollfree doctor [--rpc <url>] environment checks
 *
 * Default posture: simulate, verify, print. Live submission requires --live.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { b58encode } from './base58.js';
import { AXIOM_ROUTER, PUMP_AMM, isProgramId } from './programs.js';
import { auditFee, decodeBaseline } from './decode.js';
import { buildRebuildPlan, checkUnwrapInvariants, describePlan, planFromJson, planToJson } from './rebuild.js';
import { describeReport, verifyRebuild } from './verify.js';
import { executePlan, fetchBlockhash, loadKeypair } from './submit.js';
import { AXIOM_TIERS, computeLedger, defaultLedgerInput, netFeeQuote } from './ledger.js';
function parseArgs(argv) {
    const _ = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const body = a.slice(2);
            const eq = body.indexOf('=');
            if (eq >= 0) {
                flags[body.slice(0, eq)] = body.slice(eq + 1);
            }
            else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                flags[body] = argv[++i];
            }
            else {
                flags[body] = true;
            }
        }
        else {
            _.push(a);
        }
    }
    return { _, flags };
}
const str = (v, name) => {
    if (typeof v !== 'string' || v.length === 0) {
        console.error(`missing required --${name}`);
        process.exit(2);
    }
    return v;
};
const num = (v, fallback) => {
    const n = typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : fallback;
};
function loadRawFixture(path) {
    if (!existsSync(path)) {
        console.error(`file not found: ${path}`);
        process.exit(2);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
}
function loadPlan(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}
function runPipeline(raw, verbose) {
    const label = raw.label ?? 'inline';
    const baseline = decodeBaseline(raw, label);
    const { plan, fee } = buildRebuildPlan(baseline, { fixture: label });
    const report = verifyRebuild(baseline, plan);
    const unwrapProblems = checkUnwrapInvariants(baseline, plan);
    if (raw.description)
        console.log(`\n== fixture: ${label}`);
    if (raw.description)
        console.log(`   ${raw.description}`);
    console.log(describePlan(plan, fee));
    if (unwrapProblems.length > 0)
        console.log(`  unwrap-invariant problems: ${unwrapProblems.join('; ')}`);
    console.log(describeReport(report));
    const ok = report.pass && unwrapProblems.length === 0;
    if (verbose && ok) {
        const json = planToJson(plan);
        console.log(`  rebuilt transaction outline:`);
        for (const ix of json.instructions) {
            console.log(`    -> ${ix.programId.slice(0, 12)}…  data[0..8]=${ix.data.slice(0, 8)}  accounts=${ix.keys.length}`);
        }
    }
    console.log(`  result: ${ok ? 'RECONSTRUCTION VERIFIED — fee instrument absent, settlement intact' : 'RECONSTRUCTION FAILED — see checks above'}`);
    return { label, ok };
}
// --------------------------------------------------------------------- demo
function cmdDemo() {
    const files = ['explicit-fee-transfer', 'router-skim', 'hook-fee'].map((t) => resolve('fixtures', `axiom-base-${t}.json`));
    const results = [];
    for (const f of files) {
        if (!existsSync(f)) {
            console.error(`missing fixture ${f} — run: tollfree fixtures`);
            return 2;
        }
        results.push(runPipeline(loadRawFixture(f), true));
    }
    console.log('\n== accounting (published schedule shape) ==');
    const ledger = computeLedger({ ...defaultLedgerInput(), tradeSizeSol: 10 });
    const fmt = (x) => x.toFixed(6);
    console.log(`  terminal-assembled: total ${fmt(ledger.baseline.total)} SOL (${ledger.baseline.bps.toFixed(1)} bps)`);
    console.log(`    platform fee gross ${fmt(ledger.baseline.platformFee)} − cashback ${fmt(ledger.baseline.cashback)} = net ${fmt(ledger.baseline.netPlatformFee)}`);
    console.log(`  self-assembled    : total ${fmt(ledger.rebuilt.total)} SOL (${ledger.rebuilt.bps.toFixed(1)} bps)`);
    console.log(`    platform fee 0 − cashback 0 = net 0`);
    console.log(`  saving            : ${fmt(ledger.savings.absolute)} SOL per 10 SOL traded (${ledger.savings.bps.toFixed(1)} bps)`);
    console.log(`  MEV break-even    : ${ledger.mevBreakEvenBps} bps of expected adverse selection erases the saving`);
    for (const r of ledger.retained)
        console.log(`  retained          : ${r}`);
    const allOk = results.every((r) => r.ok);
    console.log(`\ndemo: ${allOk ? 'all reconstructions verified' : 'FAILURES PRESENT'}`);
    return allOk ? 0 : 1;
}
// -------------------------------------------------------------------- decode
function cmdDecode(file, json) {
    const raw = loadRawFixture(file);
    const baseline = decodeBaseline(raw, raw.label ?? file);
    const fee = auditFee(baseline);
    if (json) {
        console.log(JSON.stringify({ baseline, fee }, null, 2));
        return 0;
    }
    console.log(`signature : ${baseline.signature}`);
    console.log(`fee payer : ${baseline.feePayer}`);
    console.log(`slot      : ${baseline.slot}`);
    baseline.instructions.forEach((ix, i) => {
        console.log(`[${i}] ${ix.classification.padEnd(14)} ${ix.name.padEnd(16)} ${ix.programId.slice(0, 14)}… accounts=${ix.accounts.length} data=${ix.data.length}b58`);
        if (ix.note)
            console.log(`     note: ${ix.note}`);
    });
    console.log('\nfee audit:');
    for (const e of fee.evidence)
        console.log(`  - ${e}`);
    if (fee.hookRisk)
        console.log(`  ! ${fee.hookRisk}`);
    return 0;
}
// ---------------------------------------------------------------------- plan
function cmdPlan(file, out, json) {
    const raw = loadRawFixture(file);
    const baseline = decodeBaseline(raw, raw.label ?? file);
    const { plan, fee } = buildRebuildPlan(baseline, { fixture: raw.label ?? file });
    const serialised = planToJson(plan);
    if (out) {
        writeFileSync(out, JSON.stringify(serialised, null, 2) + '\n');
        console.error(`plan written to ${out}`);
    }
    if (json) {
        console.log(JSON.stringify(serialised, null, 2));
        return 0;
    }
    console.log(describePlan(plan, fee));
    return 0;
}
// -------------------------------------------------------------------- verify
function cmdVerify(file, planFile, json) {
    const raw = loadRawFixture(file);
    const baseline = decodeBaseline(raw, raw.label ?? file);
    let plan;
    if (planFile) {
        plan = planFromJson(loadPlan(planFile));
    }
    else {
        plan = buildRebuildPlan(baseline, {}).plan;
    }
    const report = verifyRebuild(baseline, plan);
    if (json) {
        console.log(JSON.stringify(report, null, 2));
        return report.pass ? 0 : 1;
    }
    console.log(describeReport(report));
    return report.pass ? 0 : 1;
}
// ---------------------------------------------------------------------- fees
function cmdFees(size, tierName, json) {
    const tier = AXIOM_TIERS.find((t) => t.name.toLowerCase() === tierName.toLowerCase()) ?? AXIOM_TIERS[AXIOM_TIERS.length - 1];
    const quote = netFeeQuote(size, tier);
    const ledger = computeLedger({
        ...defaultLedgerInput(),
        tradeSizeSol: size,
        cashbackBps: tier.cashbackBps,
    });
    if (json) {
        console.log(JSON.stringify({ tier: tier.name, quote, ledger }, null, 2));
        return 0;
    }
    console.log(`tier ${tier.name}: net fee ${(tier.netFeeBps / 100).toFixed(3)}% (cashback ${(tier.cashbackBps / 100).toFixed(3)}%)`);
    console.log(`one ${size} SOL trade through the terminal: net platform fee ${quote.net.toFixed(6)} SOL`);
    console.log(`one ${size} SOL trade self-assembled  : net platform fee 0.000000 SOL`);
    console.log(`all-in comparison (pool fee + network + expected MEV included):`);
    console.log(`  terminal-assembled: ${ledger.baseline.total.toFixed(6)} SOL (${ledger.baseline.bps.toFixed(1)} bps)`);
    console.log(`  self-assembled    : ${ledger.rebuilt.total.toFixed(6)} SOL (${ledger.rebuilt.bps.toFixed(1)} bps)`);
    console.log(`  saving            : ${ledger.savings.absolute.toFixed(6)} SOL (${ledger.savings.bps.toFixed(1)} bps)`);
    console.log(`  MEV break-even    : ${ledger.mevBreakEvenBps} bps — beyond that, self-assembly costs more than the fee`);
    return 0;
}
// -------------------------------------------------------------------- submit
async function cmdSubmit(planFile, keypairFile, rpcUrl, live) {
    const plan = loadPlan(planFile);
    const keypair = loadKeypair(readFileSync(keypairFile, 'utf8'));
    console.log(`plan: ${plan.archetype}, ${plan.instructions.length} instructions, dropped ${plan.dropped.length}`);
    if (live)
        console.log('LIVE SUBMISSION ENABLED — real funds, real consequences');
    else
        console.log('simulation mode (add --live to submit for real)');
    const result = await executePlan(plan, { rpcUrl, keypair, live });
    if (result.error) {
        console.error(`error: ${result.error}`);
        return 1;
    }
    console.log(`mode: ${result.mode}`);
    if (result.signature)
        console.log(`signature: ${result.signature}`);
    if (result.unitsConsumed !== undefined)
        console.log(`units consumed: ${result.unitsConsumed}`);
    for (const line of result.logs ?? [])
        console.log(`  log: ${line}`);
    return 0;
}
// -------------------------------------------------------------------- doctor
async function cmdDoctor(rpcUrl) {
    let ok = true;
    const check = (name, pass, detail) => {
        console.log(`  [${pass ? 'ok' : 'FAIL'}] ${name}: ${detail}`);
        if (!pass)
            ok = false;
    };
    const major = Number(process.version.slice(1).split('.')[0]);
    check('node >= 20', major >= 20, process.version);
    check('settlement program id well-formed', isProgramId(PUMP_AMM.program), PUMP_AMM.program);
    check('registry decoder self-test', b58encode(new Uint8Array([1, 2, 3])) === 'Ldp', 'base58 codec functional');
    check('wrapper program known', isProgramId(AXIOM_ROUTER.program), 'fixture-scoped assembly router');
    const hasFixtures = ['explicit-fee-transfer', 'router-skim', 'hook-fee'].every((t) => existsSync(resolve('fixtures', `axiom-base-${t}.json`)));
    check('fixtures present', hasFixtures, hasFixtures ? 'fixtures/ complete' : 'run: tollfree fixtures');
    if (rpcUrl) {
        try {
            const bh = await fetchBlockhash(rpcUrl);
            check('rpc reachable', bh.length >= 32, `blockhash ${bh.slice(0, 8)}…`);
        }
        catch (e) {
            check('rpc reachable', false, String(e));
        }
    }
    return ok ? 0 : 1;
}
// ---------------------------------------------------------------------- main
async function main() {
    const { _, flags } = parseArgs(process.argv.slice(2));
    const cmd = _[0] ?? 'demo';
    switch (cmd) {
        case 'demo':
            return cmdDemo();
        case 'decode':
            return cmdDecode(str(flags.file, 'file'), flags.json === true);
        case 'plan':
            return cmdPlan(str(flags.file, 'file'), typeof flags.out === 'string' ? flags.out : undefined, flags.json === true);
        case 'verify':
            return cmdVerify(str(flags.file, 'file'), typeof flags.plan === 'string' ? flags.plan : undefined, flags.json === true);
        case 'fees':
            return cmdFees(num(flags.size, 10), typeof flags.tier === 'string' ? flags.tier : 'champion', flags.json === true);
        case 'submit':
            return await cmdSubmit(str(flags.file, 'file'), str(flags.keypair, 'keypair'), str(flags.rpc, 'rpc'), flags.live === true);
        case 'fixtures': {
            const { buildFixtures } = await import('../scripts/make-fixtures.js');
            const dir = typeof flags.out === 'string' ? flags.out : 'fixtures';
            const files = buildFixtures(dir);
            console.log(`wrote ${files.length} fixtures to ${dir}`);
            return 0;
        }
        case 'doctor':
            return await cmdDoctor(typeof flags.rpc === 'string' ? flags.rpc : undefined);
        default:
            console.error(`unknown command: ${cmd}
usage: tollfree [demo|decode|plan|verify|fees|submit|fixtures|doctor]`);
            return 2;
    }
}
main()
    .then((code) => process.exit(code))
    .catch((err) => {
    console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
