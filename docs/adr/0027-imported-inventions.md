# ADR-0027: Inventions May Arrive as a File From the Operator's Own Claude Chat

## Status

Accepted. This extends ADR-0026.

## Context and Decision

Inventor Mode calls Claude through Keel's API key. Each brief is billed per token, and the owner already pays for a Claude subscription. So Keel also accepts **Imported Inventions**:

- **Keel writes the prompt.** Keel builds the chat prompt from the brief, using the same condition-language reference as the API prompt, so the two never drift apart. It asks for range and originality rather than caution, and lets Claude pick each idea's market, direction, stop and target.
- **The operator carries it across.** The operator pastes the prompt into claude.ai and brings back the JSON file, or the whole reply. Keel finds the JSON in plain, fenced or prose-wrapped text. Each file may hold at most 20 Inventions.
- **The same checks, applied more strictly.** Every Imported Invention goes through the ADR-0026 check. No brief stands behind a file, so an Invention keeps its own market and direction. A market Keel does not trade is rejected, not replaced.
- **No repair call.** Keel has no chat to reply to. It returns each rejection, with its reason, as a message the operator pastes back into the same chat.
- **The same Sea Trial.** Passing Inventions become a batch with source `imported`. They count towards the trial total behind the luck adjustment.

## Considered Options

- **Drive claude.ai from Keel with the operator's login**: rejected. It breaks the subscription's terms, and it would put a browser session on the server.
- **Accept whole Strategy Specs**: rejected. That would bypass the Invention boundary: the fixed ATR stop, the clamped ranges and the size limits.

## Consequences

- Imported batches bypass the LLM Gateway, so none of its cost caps, audit records or training-contamination flags apply. Keel cannot tell what model wrote the file, or whether a human edited it. Only the checks and the Sea Trial stand between the file and a launch.
- The prompt and the API prompt share one language section. A change to the condition language must update that section.
