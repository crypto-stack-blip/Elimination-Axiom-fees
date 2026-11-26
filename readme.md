# AXIOM ZERO

A project within AXIOM designed to eliminate fees: not reduce them, not hide them, remove the reason they exist.

> **Status:** concept and design. The mechanism, component names (Float Engine, Operating Pool) and allocation split below are a proposed design, not a description of a live system. No figures here are forecasts or promises.

## The problem

A fee is not a law of nature. It is the visible edge of four stacked costs, all billed to the same person (the user) at the same moment (the point of use):

1. **Finding a counterparty**: a middleman charges for the introduction.
2. **Moving value**: every hop through a network or settlement system takes a cut.
3. **Waiting**: balances in transit or held in reserve are idle, and someone is compensated for that.
4. **Running the business**: servers, staff, compliance, support, margin.

Nothing requires these to be billed to the user, or billed per transaction. AXIOM ZERO attacks each layer directly.

## How it eliminates fees

| Cost layer | Pillar | What it does |
|---|---|---|
| Finding a counterparty | **Internal matching** | Every request is first matched against opposing requests already inside AXIOM, at a published mid-market reference price. No outside trip, no outside middleman, no hidden spread. |
| Moving value | **Net settlement** | A continuous ledger of obligations is settled in batches. Only the net remainder moves, and batch cost is split across every transaction in it. |
| Waiting | **Float Engine** | Idle balances go into a narrow, public set of low-risk instruments. The income funds the Operating Pool instead of being kept while the user is also charged. |
| Running the business | **Operating Pool** | A separately accounted pool, funded by float income and efficiency savings, pays operating costs so users are never billed at the point of use. |

A fourth mechanism, **surplus return**, changes who captures surplus. Efficiency gains are split three ways: refill the Operating Pool, reward liquidity providers (which strengthens matching), and return the remainder to the participants whose activity created it.

### The flywheel

More users mean more internal matches, so less outside cost. Less outside cost lightens the load on the Operating Pool, leaving more surplus. Surplus rewards liquidity, which deepens matching. Scale makes the cost curve bend toward zero instead of up, and the platform earns more when balances are healthy and users stay active, so its incentives point the same way as the user's.

## Technical issues and how the design handles them

Removing fees is easy to claim and hard to build. These are the main engineering and design problems, with the approach proposed for each.

**1. Unmatched demand.**
Internal matching only works when an opposing request exists. Where none does, the request must be routed outside, which costs money. *Approach:* route the unmatched remainder externally, have the Operating Pool absorb that cost, and record it on the public ledger. Matching depth is the key metric, which is why liquidity-provider rewards feed back into the pillar.

**2. Fair reference pricing.**
"No hidden spread" is only true if the reference price is trustworthy. *Approach:* match at a published mid-market reference, and treat any platform-benefiting gap between the matched price and the reference as a design failure. This needs a reliable price source and an auditable record of the price used for each match.

**3. Settlement latency versus cost.**
Larger batches are cheaper per transaction but make users wait longer. *Approach:* tune batch size and timing as an explicit trade-off, and let the netting ledger update continuously so obligations are tracked instantly even when final settlement is batched.

**4. Float safety and liquidity.**
Earning on idle balances must never put user funds at risk or delay withdrawals. *Approach:* a narrow, public list of permitted instruments that cannot be widened quietly; no speculative use; holdings that can be released quickly; and balances held separately from the Operating Pool so running costs can never be paid from user funds.

**5. Variable income.**
Float income rises and falls, and a bad month must not tempt anyone to bring fees back. *Approach:* a protected reserve buffer absorbs swings. If income falls, the design obliges the project to cut its own costs before it may ever charge users.

**6. Unavoidable third-party costs.**
Some charges come from outside networks AXIOM does not control. *Approach:* the Operating Pool absorbs them on the user's behalf and the ledger shows the exact amount. The promise is not that costs vanish, but that they stop landing on the user.

**7. Proving the zero is real.**
A zero-fee claim must show that fees were not simply moved somewhere less visible. *Approach:* a public fee ledger (what the pool earned, spent and holds in reserve), zero applying to every step including entry, exit and transfer, independent review of the permitted-instrument and surplus rules, and advance notice of any change to them.

## Safeguards at a glance

- No hidden spread
- No surprise charges at any step
- Public fee ledger
- Reserve buffer
- Independent review and advance notice of rule changes

## Common questions

- **How does it survive if it's free?** The structure pays for itself through the Operating Pool, not the user.
- **What if returns fall?** The reserve absorbs it, the ledger shows it, and costs are cut before users are charged.
- **Is my money used for risky bets?** No. Permitted instruments are narrow, public and conservative.
- **Why hasn't this been done?** Each piece alone is not enough. Internal matching, net settlement, float income and surplus return only work when designed together and paid for by the right pool.

## Documentation

- `AXIOM_ZERO_Introduction.pdf`: the four-page introduction written to explain the project to a general audience.
- `README.md`: this file.

## Before publishing

Replace the placeholder project name, component names, surplus split and any unspecified details with the real mechanism and figures.
