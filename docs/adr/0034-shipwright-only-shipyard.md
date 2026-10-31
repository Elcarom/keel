# ADR-0034: The Shipwright Designs Every Boat, and Blueprints Become Rigs

## Status

Accepted. This retires ADR-0024's Blueprint mode and extends ADR-0026 and ADR-0027.

## Context and Decision

Blueprint mode let Claude pick one of the reviewed archetypes and tune five numbers. Since ADR-0026, the Shipwright (then called the Inventor) has done everything Blueprint mode could, including baskets and pairs (ADR-0028, ADR-0032), and the night shift already defaulted to it. Two ways to design made the Shipyard harder to read, and the menu of shapes held back the self-managing fleet (ADR-0033).

- **One Shipwright, two ways to reach it.** The **Shipwright** runs Claude on the owner's subscription; the **Shipwright via a chat** writes the same prompt for a chat with any model and imports the JSON it returns. Every Invention passes the same checks and Sea Trial either way.
- **A smaller brief.** A brief names its waters, direction, count and notes. Styles and risk appetite are gone: they only steered Blueprints, and an Invention sets its own stop and target.
- **Without Claude linked**, the Shipwright offers Keel's own sample designs, marked as samples.
- **Blueprints are renamed Rigs.** A boat's set-up (its coins, rules, stop, target and exits) is its Rig, in the code, the API and the database (`rig_json`, renamed in place on start-up). Boats already at sea on an archetype keep sailing it: the archetype compilers stay, and only new designs are inventions.

## Consequences

- Night shift Upgrades of an archetype boat come back as Inventions that keep its idea.
- Pair boats are designed as invented pairs that read their second coin through a spread.
- Older ADRs keep the word Blueprint; it means what this ADR calls a Rig.
