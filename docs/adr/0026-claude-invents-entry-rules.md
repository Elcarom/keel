# ADR-0026: Claude May Invent Entry Rules, Within the Spec Language

## Status

Accepted. This partly supersedes ADR-0024's "the model drafts Blueprints, never strategies". ADR-0034 makes the Inventor the Shipyard's only designer.

## Context and Decision

With Blueprints, Claude could only pick one of thirteen reviewed archetypes and tune five numbers. The owner wants an edge that a fixed menu cannot express. In **Inventor Mode**, Claude writes the entry rules itself:

- **The Strategy Spec condition language is the boundary.** Claude writes conditions and numbers using price, volume, nine indicator kinds, look-backs of up to 48 bars, and the bar's UTC hour and weekday. The hour and weekday are new to the language and come from each bar's open time, so they are causal. Claude cannot touch the protective stop, the take-profit model, sizing or execution. Keel attaches an ATR(14) stop to every Invention.
- **Keel checks every Invention before it exists.** The checks cover schema, declared indicator ids, outputs each kind actually has, look-back length, and the Spec's existing size limits: 32 nodes across both rules and shallow nesting. Clamping and the brief's instruments and direction apply as for Blueprints. A failed Invention goes back to Claude once with Keel's exact complaint. Whatever still fails is dropped, and the operator is told which.
- **Claude thinks before inventing.** Inventor requests use adaptive thinking at high effort and no schema-constrained decoding, because the condition language is recursive. Keel extracts and validates the JSON itself.
- **Inventions face the same Sea Trial (ADR-0025).** For an Invention, the nudges scale every indicator window (−25% and +33%) and every rule threshold (±10%). Clock values are never scaled. The trial count behind the luck adjustment includes every Invention.
- **Rules are shown in plain English**, rendered by Keel from the compiled rules, never from Claude's prose. "Long when RSI(7) crosses above 25 and close > EMA(160)" is what trades.

## Considered Options

- **Let Claude write code**: rejected. It would put arbitrary model output on the trading path, and no review could bound it.
- **Raise the Spec's size limits for Inventions**: rejected. Small rules are easier to read, and harder to curve-fit.
- **Constrain the output with a depth-unrolled JSON schema**: rejected for now. It adds a large schema for no gain over validate-and-repair.

## Consequences

- Inventor briefs cost more than Blueprint briefs: there is a thinking pass, longer outputs and sometimes a repair call.
- Invented Boats compile from their stored Invention on every start. A future change to the condition language must keep old Inventions compiling, or migrate them.
- Without an Anthropic key, Inventor Mode offers six hand-written sample Inventions, checked the same way.
