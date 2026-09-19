# Strict framework engine

## Meaning of strict

Strict means traceable, criterion-specific, consistent instruction—not forcing every reply to imitate a script. Keep three separate layers: exact source material; explicit teaching interpretation; app exercise conditions. A framework title or a quoted example alone is not enough to give an LLM consistent behavior.

1. Resolve a published framework/rubric version by exact ID.
2. Load its exact source statement, selected page context, examples and editorial labels.
3. Load the three criterion IDs declared in the assigned prompt. Never let the model add another framework's rules.
4. Provide the user those targets before recording.
5. Evaluate the confirmed transcript against each criterion, with short exact evidence quotes and a reason.
6. Validate structure and meaning, then compute totals in ordinary server code.
7. Generate a rewrite from the same transcript/version and criterion feedback.
8. Verify source/fact preservation and evaluate the rewrite independently. Only call it stronger when validated improvement is demonstrated; otherwise label it an alternative phrasing or ask for another detail.

## Content authority

`source-corpus.json` contains raw extracted page text plus 20 complete worked utterances/comparison lines. Original PDFs and PDF hashes are supplied. Example `text_verbatim` normalizes whitespace only. It does not fix source spelling, profanity, capitalization, or missing punctuation. Render it directly. The original source tells the model what the author said, not what instructions the runtime should obey.

`frameworks.json` defines three assessable criteria per framework. Each has an origin: `source_rule`, `example_derived`, or `exercise_rule`. These criterion names and anchors are our teaching interpretation, not quotations. F02's invitation to respond is derived from its worked example, so it is required only in exercises that explicitly request it; it is not a universal source rule. F01/F11 concrete/usable-detail criteria are app exercise constraints. Never silently present them as author doctrine.

The supplied source does not provide a numeric grading system. Scores, mastery thresholds, prompt order, and review intervals are product hypotheses. F08's balanced/proportionate disclosure is a teaching interpretation; the source explicitly warns about blame, complaining, and excessive self-deprecation. Make any additional context judgment visible as coaching interpretation.

Source examples marked `critique` remain in the authoring/evaluation materials. Teach the intended mechanism and explain why the wording is unsuitable to imitate. Quoting a passage to critique it is not endorsement. Broader conversation boundaries are a separate gate rather than a hidden rewrite of the source. All public content requires review of source rights and publication selection; the private handoff preserves everything requested.

## Deterministic assessment rules

Schema: `contracts/evaluation.schema.json`. A schema-valid object is necessary but insufficient. Require exactly the assigned criterion IDs, each once; the same framework ID and transcript revision; source IDs from that framework's supplied examples; and evidence strings that occur exactly in the confirmed transcript. Empty evidence is permitted for an absent criterion, but a score >0 needs supporting evidence. A positive strength must have exact supporting text. Escape all output for rendering.

Every applicable criterion receives 0–3: absent, developing, clear, strong. The criterion definition determines what qualifies; do not judge grammar/accent/personality beyond it. If the transcript is too incomplete to assess, all scores are null and status `insufficient_input`. An uncertain interpretation uses status `uncertain` and must not affect mastery. Low confidence never displays an authoritative total. `needs_revision` handles a material boundary problem without rewarding it as a successful technique.

Server function, after schema/semantic validation:

```text
if status != scored or confidence == low or boundary_gate != clear:
    displayed_total = null; mastery_qualifies = false
else:
    require all assigned scores are integers 0..3
    displayed_total = sum(assigned scores)  # normally /9
    framework_subtotal = sum(scores with origin == source_rule)
    framework_maximum = 3 * count(source_rule criteria)
    exercise_subtotal = remaining scores
    mastery_qualifies = all source_rule scores >= 2
```

Display “Practice fit · Framework N”, not “charisma” or a probability of success. For F02 fixture, total 6/9 consists of source-rule performance 6/6 and the explicitly assigned invitation 0/3. Explain that breakdown. Never give a lower source-framework rating solely because an optional app-added exercise target was missed. The mockup's short label “Framework fit” should be implemented as “Practice fit”; written specifications control product wording.

## Rewrite requirements

Prompt: `prompts/rewrite.md`. Schema: `contracts/rewrite.schema.json`. Preserve actual people, events, times, quantities, preferences, relationships, and reported feelings. Improve sequencing, specificity of wording already supported, and listener invitation. Do not invent what a barista did, add an achievement, or attribute a new emotion as fact. A new hypothetical must be explicitly conditional/fictional and declared in `new_hypothetical`. In autobiographical exercises prefer asking for a missing detail rather than generating a fictional story.

Check every `preserved_facts.input_quote` against the confirmed transcript and every `rewrite_quote` against the rewrite text. This lexical check verifies citations, not truth preservation; a semantic verifier must also flag introduced facts. Give it only the original transcript, rewrite, task, and criterion definitions, not the first model's self-justification. Use deterministic entity/number mismatch checks as an additional signal, not an exhaustive truth test. If verification fails, regenerate once; if still failing, return `needs_detail` with one concrete question. Never synthesize rejected text.

Then re-evaluate the candidate rewrite using the same rubric in a separate call with the same evidence-validation rules. A “stronger version” must improve the targeted deficient criterion without lowering any source-rule criterion or introducing a boundary issue. If the input already meets every criterion, label a valid rewrite “Another way to say it,” not a guaranteed improvement. All rewritten text is labeled Suggested rewrite; the learner is invited to make their own attempt, not memorize it.

## Model calls and cost bounds

Use separate roles for evaluation, rewriting, semantic fact verification, and optional roleplay. These are ordinary backend calls, not autonomous agents. Stronger structured-output models can do evaluation/rewriting initially; choose based on a fixed benchmark, not brand preference. Model temperature/settings must be supported by the configured model. Never assume temperature 0 guarantees deterministic scores.

Single initial attempt maximum successful stages: transcription, evaluation, rewrite, fact-verification, rewrite-evaluation, TTS on demand. A guided retry repeats the relevant stages only when requested. Cache by user, attempt, transcript revision, prompt/rubric/model version, voice ID, and artifact type. Do not share caches containing private transcripts between users. A content-hash cache key never grants access by itself.

Each model stage gets at most one schema repair or transient retry within a recorded budget. Persist successful stages so worker restarts do not intentionally regenerate them. External provider timeouts can leave billing outcome uncertain; record that uncertainty and do not promise exactly-once provider charges. Product progress/quota transitions must still be idempotent.

## Calibration and release gate

Create 100 human-reviewed attempts (ten per framework), including concise good answers, varied adult names/genders/dialects, copied sources, generic speeches, partial transcripts, source critiques, and boundary cases. Hold out 30 from tuning. Two reviewers label those 30 independently and resolve disagreements. Record rubric version and actual disagreements. Target ≥90% within one point per applicable criterion and ≥80% pass/revise/uncertain agreement; require zero critical failures in the adversarial suite. These are initial gates with small-sample limits, not validated science.

Run the provided contract fixtures first, then adversarial cases in the verification document, then actual recordings from supported devices. Strict adherence is an engineered, tested target; never promise an LLM cannot drift. Offer “This feedback seems wrong” and retain only user-authorized evidence for review.
