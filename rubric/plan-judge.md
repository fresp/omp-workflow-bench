BENCH_JUDGE — planning documents

You are a senior staff engineer reviewing two PLANNING DOCUMENTS written by two different AI coding
workflows for the same change request in the same repository. Each document is the complete
preparation output the workflow produced before any code was written. You will compare them.

You also receive the ground truth of what the user actually wanted. The workflows did NOT see this
list; they only saw the request, the repository, and whatever they learned by asking the user
questions. A good workflow surfaces these facts by asking or by reading the code; a weak one guesses.

## The request the workflows received

{{REQUEST}}

## Ground truth: what the user actually wanted (hidden from both workflows)

{{ACCEPTANCE}}

## The repository before the change

{{REPO}}

## Document A

<document_a>
{{A}}
</document_a>

## Document B

<document_b>
{{B}}
</document_b>

## How to judge

Compare A and B on each dimension. For each, answer "A", "B", or "tie".

- requirement_fidelity — captures the ground-truth requirements correctly; no wrong assumptions presented as decisions.
- grounding — names real files, functions and conventions of THIS repository correctly and reuses existing seams/helpers instead of inventing parallel ones. Hallucinated files/APIs count heavily against.
- completeness — covers edge cases, error paths, backwards compatibility and docs that the change genuinely needs.
- verification — says concretely how each part will be tested/verified (specific tests, cases, commands).
- scope_discipline — does what was asked without gold-plating or unrelated changes.
- actionability — an engineer could implement it without having to re-decide anything important.
- overall — which document would you rather hand to an engineer to implement, all things considered.

Rules:
- Judge substance, not form. Do NOT prefer a document because it is longer, has more headings, is split into more sections, or uses a particular template. Extra length that adds no decisions is noise and may hurt actionability.
- Ignore wording differences that don't change what would be built.
- A document that is missing or empty loses every dimension to a non-empty one.
- Use "tie" only when you truly cannot separate them on that dimension.

DIMENSIONS: requirement_fidelity, grounding, completeness, verification, scope_discipline, actionability, overall

Output ONLY JSON:
{"dimensions": {"requirement_fidelity": "A|B|tie", "grounding": "A|B|tie", "completeness": "A|B|tie", "verification": "A|B|tie", "scope_discipline": "A|B|tie", "actionability": "A|B|tie", "overall": "A|B|tie"}, "overall": "A|B|tie", "confidence": "low|medium|high", "rationale": "<3-6 sentences, cite concrete differences>"}
