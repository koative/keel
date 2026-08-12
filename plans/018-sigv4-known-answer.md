# SigV4 Presigned URL Verification Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-06 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Pin the presigned-URL output to something that can only be right if the canonical request, region, host and encoding choices are right — not just shape. A regression in SigV4 construction currently passes every test and surfaces only as client 403s in production.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `packages/storage/src/client.test.ts:21-22,28-29,41-42,51-52` — asserts only host, pathname, `X-Amz-Expires=300`, and a 64-hex `X-Amz-Signature` shape. The comment at `:21` says "Signing is checked against a real MinIO; these are the choices we make" — but no compose service provides MinIO (grep `minio` across both docker-compose files: zero hits).
2. The repo's own signing choice — the `virtualHostedStyle` inversion — is already covered; what is not covered is whether the signature bytes themselves are correct.
3. `packages/storage/src/client.ts:75-86` — the `Storage` surface is `createDownloadUrl`/`createUploadUrl` (presign GET/PUT), `delete`, `exists`, `read`, `write`. `PresignOptions = { contentType?: string; expiresInSeconds: number }` with `MAX_EXPIRES` 7 days.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- Do not add a MinIO compose service unless the plan says so — the repo has no storage service today and adding one is a bigger decision (see DIR-02/plan 036).
- The suite must be deterministic: a known key/secret/date/region, so the expected signature is a constant.

## Do not

- Do not assert against a signature computed at runtime by the same code under test — that is shape-assertion again.
- Do not commit a signature literal without a comment saying how it was derived (someone must be able to re-derive it).
- Do not change the signing implementation; only the test.

## File structure

| File | Responsibility |
|---|---|
| `packages/storage/src/client.test.ts` | **Modify.** Add known-answer vectors. |

### Task 1: Known-answer vectors

**Files:** `packages/storage/src/client.test.ts`

\- [x] **Step 1:** Read the whole suite and the client's signing path (`client.ts` — how it builds the canonical request: which region, which host style, which headers are signed). Note the exact set of parameters the client passes to the signer.
\- [x] **Step 2:** Construct one known-answer case by hand, using the AWS SigV4 test suite's published example (the AWS docs "Signature Version 4 signing process" worked example — key `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, date `20150830T123600Z`, region `us-east-1`, service `s3`) OR — if the client does not allow injecting the signing date — derive the expected signature with an independent tool: install nothing new; instead compute it with a tiny standalone script using `@aws-sdk/sigv4` or a hand-rolled HMAC chain in a scratch file (not committed), for the client's actual inputs. Record in a comment how the expected value was produced so a future reader can re-derive it.
\- [x] **Step 3:** Add a test that constructs the client with fixed credentials + a fixed bucket/region (the test config already has `CONFIG` — check what it allows), generates a download URL, and asserts the **exact** `X-Amz-Signature` value AND the exact canonical pieces the suite can observe (host, path, `X-Amz-Date` if fixed, `X-Amz-Credential` scope — which encodes region+service and catches a region regression).
\- [x] **Step 4:** Run the suite: `cd packages/storage && bun test src/client.test.ts` — green. If the first expected value is wrong (signature mismatch), that is the vector being wrong, not the code — re-derive the expectation independently before changing anything in the test's inputs.
\- [x] **Step 5:** Commit: `test(storage): pin the SigV4 signature to a known answer`.

## Done when

- A regression in region, host-style, canonical-request construction, or header signing changes the asserted signature and fails the suite.
- The expected value is re-derivable from a comment in the file.
- No runtime dependency on MinIO or any network.

## Out of scope

- Adding a MinIO compose service or real round-trip tests (a deployment decision; see DIR-02/plan 036).
- Changing the signing implementation.
