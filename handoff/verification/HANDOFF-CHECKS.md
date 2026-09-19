# Handoff verification record

Checked 19 September 2026 in the authoring workspace.

| Check | Observed result |
|---|---|
| Original source coverage | PASS: 10 PDFs, 44 pages included |
| Original bytes | PASS: all 10 bundled PDF SHA-256 hashes match extracted corpus metadata |
| Verbatim examples | PASS: 20 records match normalized source page text and hashes; full examples included in Markdown |
| Exact framework statements | PASS: all 10 source statements occur in their original first-page extraction |
| Curriculum references | PASS: 10 framework configs, 30 unique daily prompts, 30 unique lesson seeds; IDs consistent; F04/F09 not invented |
| Publication state | PASS: lesson/prompt seeds explicitly draft; Notice answer keys identified as authoring work |
| Fixture contracts | PASS: sample feedback/rewrite/verifier/partner objects match the JSON Schema keyword subset used here; invalid score and extra-field controls rejected |
| Evidence and totals | PASS: sample quotes match confirmed transcript; total 6/9 and source subtotal 6/6 calculated consistently |
| Visual references | PASS: two PNG boards inspected, six core screens, marshmemos naming; production-copy differences explicitly documented |
| Readable package structure | PASS: Markdown code fences balanced and JSON files parse |

The response-contract test uses the bundled standard-library keyword-subset validator, not a full independent JSON Schema meta-validator. Use a maintained validator in the implemented app and enforce all semantic checks.

Not performed: native app build; microphone recording; provider transcription/evaluation/rewriting/TTS; fact-verifier quality evaluation; persistence/RLS integration; payment purchase; notification delivery; physical-device/accessibility testing; public release or store submission. No production credentials or services were created. The supplied fixtures and mockup scores are synthetic.

Run again after changing source/configuration: `python scripts/validate_handoff.py` from the extracted package root. Runtime acceptance requirements are in `docs/07-verification.md` and `PLAN.md`.
