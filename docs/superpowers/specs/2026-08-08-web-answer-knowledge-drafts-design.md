# Web Answer Knowledge Drafts Design

**Date:** 2026-08-08

## Goal

When an ordinary running question cannot be answered from the active knowledge base, search the web, produce the existing citation-grounded answer, and save a reviewable Traditional Chinese knowledge-card draft only after that answer passes all grounding validation. An administrator must approve the draft through the authenticated management API before it enters the existing R2, Queue, D1, and Vectorize ingestion pipeline.

## Scope

- Preserve the dedicated weather flow, group administration commands, and casual greetings.
- Keep the current knowledge-first behavior for ordinary running questions.
- Search Tavily only when the active knowledge base is insufficient or the existing routing rules otherwise require web evidence.
- Create a draft only from a successfully validated web-grounded answer with at least one used HTTPS web source.
- Require administrator review before publication.
- Reuse `ADMIN_API_TOKEN` and the existing knowledge ingestion infrastructure.
- Do not add a new Cloudflare Queue, Workflow, or required Secret.

## Non-goals

- Automatically publishing unreviewed web content.
- Copying or storing complete source articles.
- Replacing the weather provider, administration flow, casual-answer path, or existing citation validator.
- Building a graphical administration console or LINE-based approval commands.
- Performing a second AI generation solely to rewrite the draft.

## Architecture

The feature adds an isolated D1 draft layer between validated web answers and the existing knowledge ingestion pipeline:

1. LINE routing preserves weather, administration, and greeting behavior.
2. An ordinary running question retrieves active D1/Vectorize evidence first.
3. If that evidence is insufficient, the existing routing logic searches Tavily.
4. `GroundedAnswerService` generates and validates the answer exactly as today, including evidence-ID, citation-location, conflict, and entailment checks.
5. When the successful answer used at least one web evidence item, a deterministic draft builder creates a Traditional Chinese Markdown knowledge card from the validated answer and only its used web evidence.
6. A draft repository stores the card in D1 with status `pending`. Pending drafts are never returned by normal knowledge retrieval.
7. Authenticated management endpoints let an administrator list, inspect, approve, or reject drafts.
8. Approval sends the generated Markdown through a shared ingestion service that writes R2 state and enqueues the existing ingestion job. The normal versioned D1/Vectorize publication flow remains authoritative.

## Retrieval and Draft-Creation Rules

- Existing route precedence remains unchanged: administration and weather routing happen before knowledge answering; clearly casual greetings retain the casual path.
- Knowledge retrieval remains first for ordinary running questions.
- Web search occurs only when selected by the existing retrieval route, including insufficient knowledge, explicit web requests, or time-sensitive questions.
- A draft is eligible only when:
  - the final answer passed every existing grounding check;
  - `usedEvidenceIds` contains at least one web evidence ID;
  - at least one corresponding source uses normalized HTTPS;
  - the answer is not the insufficient-evidence fallback.
- Only used web evidence is written to a draft. Unused Tavily results are discarded.
- Draft creation is best-effort and occurs after the final grounded result is known. A D1 draft failure must not replace or suppress an otherwise valid LINE answer.
- Duplicate webhook or Queue delivery must not create duplicate drafts.

## Knowledge-Card Format

The deterministic Markdown card contains:

- a normalized Traditional Chinese topic derived from the first validated claim, bounded to 120 Unicode code points;
- a concise key-point summary derived from the already validated answer;
- a fixed applicable-context statement identifying the card as general running information;
- a fixed safety statement that the card does not replace professional medical advice, plus any limitation text already present in the validated answer;
- each used source title and normalized HTTPS URL;
- the newest retrieval timestamp among the used sources.

The builder is purely deterministic and makes no additional model call. It uses the final validated answer text, its ordered validated claims, and the used source metadata already available to the question processor. The card must not contain LINE user IDs, pseudonymous user keys, reply tokens, raw webhook payloads, or provider credentials. It does not preserve the complete source article. The original question remains only in the existing 30-day question lifecycle and is not copied verbatim into the long-lived draft.

## Data Model

Add a D1 migration for `knowledge_drafts` with these logical fields:

- `id`: stable identifier.
- `status`: `pending`, `approved`, or `rejected`.
- `topic`: normalized Traditional Chinese topic.
- `markdown`: generated knowledge card.
- `sources_json`: bounded structured source metadata containing titles, normalized HTTPS URLs, and retrieval timestamps.
- `dedupe_key`: unique hash of normalized topic plus the sorted normalized source URLs.
- `document_id`: nullable ID of the knowledge document created after approval.
- `created_at`, `updated_at`, and `expires_at`.
- `reviewed_at`: nullable review time.

The unique `dedupe_key` makes creation idempotent. Re-observing the same pending topic/source combination updates `updated_at` and source retrieval metadata without creating a second row. Approved or rejected history is not silently reopened; a materially different source set or topic produces a new key.

Pending drafts expire after 90 days and are atomically changed to `rejected`. Rejected drafts expire 30 days after rejection and are then deleted by the existing scheduled cleanup path. Approved draft metadata remains available while its referenced knowledge document exists, so operators can trace publication provenance.

## Management API

All endpoints reuse the existing constant-time `ADMIN_API_TOKEN` guard and return sanitized errors:

- `GET /admin/knowledge/drafts?status=pending`: list bounded draft summaries, newest first.
- `GET /admin/knowledge/drafts/:id`: return the full card, source metadata, status, timestamps, and linked document ID.
- `POST /admin/knowledge/drafts/:id/approve`: approve a pending draft and enqueue its Markdown through the shared knowledge ingestion service.
- `POST /admin/knowledge/drafts/:id/reject`: reject a pending draft.

Approval is idempotent. A repeated approval returns the existing `documentId` and does not create another file, job, or vector set. If R2 or Queue submission fails, the endpoint returns a stable safe error and the draft remains `pending`, permitting retry. Rejection is also idempotent. Approving a rejected draft or rejecting an approved draft returns a conflict without altering state.

## Shared Ingestion Boundary

The current file and URL routes contain upload and enqueue coordination. Extract the minimum shared service needed to accept trusted generated Markdown, claim a stable document/job ID, write the Markdown to R2, complete the pending upload state, enqueue the existing ingestion message, and clear its claim.

The approval endpoint calls this service directly. It must not perform an HTTP request back to the same Worker. Existing file and URL endpoint behavior, fencing, retry semantics, version publication, and cleanup remain unchanged.

## Error Handling and Observability

- Tavily failure follows the current knowledge-only degradation and creates no draft.
- A malformed or ungrounded AI response creates no draft.
- Draft formatting or D1 insertion failure does not change the prepared LINE answer.
- Approval-time D1, R2, or Queue failures retain a retryable pending draft.
- Events may record draft ID, status transition, source count, duration, and sanitized reason.
- Logs and telemetry must never contain the question, Markdown card, answer body, source snippets, full provider response, Authorization header, token, or API key.
- Source URLs are returned only through authenticated management responses; operational logs use counts or hashes rather than raw URLs.

## Security and Content Safety

- Require normalized HTTPS sources and retain the existing URL safety rules.
- Treat all web text as untrusted evidence, never as executable instructions.
- Do not follow source-page instructions that attempt to modify system prompts or management actions.
- Human approval is the trust boundary for credibility, copyright suitability, and editorial quality.
- The management detail response shows source provenance so the reviewer can open and verify at least one source before approval.
- Publication stores the synthesized card rather than a full source copy, reducing copyright and prompt-injection exposure.

## Testing

Use test-driven development and preserve all existing regression gates. Add coverage for:

- sufficient knowledge skips Tavily and draft creation;
- weather, administration, and greetings preserve their current paths;
- a validated web-grounded answer creates exactly one pending draft;
- insufficient, malformed, conflicted, or unentailed answers create no draft;
- only `usedEvidenceIds` contribute sources and content;
- drafts contain no user identifiers, raw webhook data, unused snippets, or secrets;
- normalized topic/source deduplication is idempotent across retries;
- list/detail endpoints require authentication and return bounded data;
- approve/reject transitions, conflicts, and repeated operations are deterministic;
- R2 or Queue failure leaves approval retryable and does not duplicate ingestion;
- approval flows through the real Miniflare D1 schema, R2/Queue fakes, ingestion consumer, embedding, Vectorize publication, and subsequent knowledge-first answer;
- cleanup expires pending and rejected drafts at their specified limits;
- telemetry remains structurally incapable of logging forbidden content.

Before deployment, run focused draft and knowledge tests, the knowledge E2E and quality suites, the full test suite, type checking, and a Wrangler dry run. Production smoke must prove web fallback creates a pending draft, approval produces a ready knowledge document, and the same question subsequently answers from knowledge without Tavily.

## Operational Result

The first unfamiliar running question may still incur Tavily and model latency. Once its validated card is reviewed and published, similar questions can use the local knowledge base first. Operators gain an explicit review queue, provenance, deduplication, retry safety, and a controlled path for growing knowledge without allowing unreviewed internet content to contaminate answers.
