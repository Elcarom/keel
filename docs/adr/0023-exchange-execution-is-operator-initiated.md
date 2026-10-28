# ADR-0023: Exchange Execution Is Operator-Initiated

## Status

Accepted

## Context and Decision

Audit 4 found that the scheduler only runs paper ticks in every Execution Mode. A strategy promoted to Demo, Live-Ramp or Live never places exchange orders on its own; exchange orders exist only through `POST /api/v1/broker/orders`, which the operator calls with step-up MFA. We keep it that way for now. Strategies trade the Paper Book autonomously, while every Venue Book entry is operator-initiated, MFA-gated (G2 on Demo, G3 for real money), risk-sized, capped at the Live-Ramp allocation, and checked against the OKX balance.

Autonomous exchange execution would be new code that places orders on an exchange account, which `AGENTS.md` puts behind human gate G2, before the code is written. That review is a decision for the owner, not something an audit remediation can settle on its own authority.

## Considered Options

- **Route promoted strategies' proposals to the exchange from the scheduler**: deferred. It needs a G2 review covering signal-driven exits (today only exchange-side stops and take-profits close Venue Book positions), stop ratcheting through `amendAlgoOrder`, restart recovery of in-flight entries, and per-strategy kill controls.
- **Autonomous Demo only**: deferred with the above. It is the natural first step because Demo evidence (H3) then accrues without operator effort, but it is still order-placing code under G2.

## Consequences

- Demo, Live-Ramp and Live Promotion Ladder evidence (Venue Book trades closed in stage) accrues only from operator-placed orders, so `demoPromotionMinTrades` and the Live-Ramp tiers advance at the operator's pace.
- Every Venue Book safeguard (MFA gates, ramp cap, balance check, heartbeat loss limits, Kill Switch) is enforced at the API and heartbeat seams, so an autonomous path added later inherits it by calling the same order pipeline.
