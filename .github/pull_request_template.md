## Summary

<!-- Link the originating spec and ticket(s), e.g., Part of #1, Closes #2 -->

## Quality & Safety Gate Checklist

- [ ] Vocabulary matches [`GLOSSARY.md`](../GLOSSARY.md) and conforms to [`docs/adr/`](../docs/adr/).
- [ ] Zero `any` in domain packages and zero raw floating-point numbers on the money/quantity path (`ScaledDecimal` only).
- [ ] No AI calls on the money path (`risk`, `ledger`, `broker`, reconciliation, protective stops).
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` pass.
- [ ] Two-axis `code-review` (Standards + Spec) completed cleanly.
- [ ] Respects Human Gates **G1**, **G2**, and **G3**.
