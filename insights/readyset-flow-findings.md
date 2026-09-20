# readyset-flow: findings from the end-to-end benchmark (for the readyset-flow tuning pass)

This supersedes `cost-efficiency-T01.md`. It merges that single-task cost analysis with the
full 12-task run and an audit of the results.

**Audience:** whoever tunes `readyset-flow` next, human or agent. Everything here comes from
`readyset-bench` run data. Treat it as **evidence plus hypotheses**:
- items marked **verify** have not been checked against the readyset source yet
- item 1 has been confirmed from the raw logs

## Where the evidence lives

| | |
| --- | --- |
| Harness | `playground/readyset-bench` (github: the readyset-bench repo) |
| Run label | `deepseek-r1`, `results/deepseek-r1/` |
| Versions | readyset-flow **0.11.2 @ 1bbd2ed**, omp 18.2.0 |
| Model | `eai1/cbai/deepseek-v4.1-flash` for planning and execution in **both** arms (same model, so this is workflow vs workflow) |
| Setup | 12 tasks on 3 small Node fixtures, 1 rep. A simulated user answers questions from a hidden persona. Each arm's approval step is auto-approved. |
| Scoring | hidden tests on the final code (objective), plus blind pairwise LLM judges with A/B swap |

Per-run evidence is in `results/deepseek-r1/<task>/readyset__…__r1/`:
- `metrics.json`: events and status
- `rpc.ndjson`: every tool call and its per-call token usage
- `sim-user.ndjson`: the grilling Q&A
- `final/changes.diff`: the code that shipped
- `compiled.json`: the grade

Also in `results/deepseek-r1/`: `report.md` (numbers) and `improve.md` (digest).

### Data quality: read before quoting anything

- **This run is contaminated.** Two benchmark processes ran the same label at once and destroyed
  each other's workspaces. The readyset cells for T03, T06 and T07 were lost (harness error, not
  readyset). Other readyset cells may have been affected. The harness now has a lock, and this run
  should **not** be quoted publicly.
- **n = 1 rep, 9 comparable tasks.** Use it for direction and for concrete defects, not magnitudes.

## Headline (9 tasks with a valid run in both arms)

| | /plan | /readyset 0.11.2 |
| --- | ---: | ---: |
| Hidden tests passed | 75% | **89%** (paired +14 pt, 95% CI [4, 25]; 5 tasks up, 0 down, 4 tied; p = 0.063) |
| Judge: implemented code, overall | | readyset wins 86% |
| Judge: planning docs, overall | | readyset wins ~78% (**length-confounded**, see finding 4) |
| Tokens per run | **1.36M** | 15.4M (11×) |
| Wall time per run | **2.4 min** | 24.9 min (10×) |
| Questions asked of the user | 0.1 | 3.2 |
| Planning output size | 12.5k chars | 45.7k chars (3–7× per task) |

By clarity, hidden-test Δ:
- ambiguous: +25 pt (driven by one task, T10)
- partial: +17 pt
- clear: +8 pt

Readyset's advantage is largest where requirements are unclear and smallest where they are clear.
The 10× cost is paid everywhere.

---

## Findings, ranked by severity

### 1. Propose implements the change and bypasses the review gate (confirmed, highest priority)

**Evidence (tool calls in `rpc.ndjson`, attributed to phases from readyset's own notify
messages):**

- **T12:** during the *Propose* turn the model:
  - edited `src/ledger.mjs` 3×
  - wrote `test/balance-cache.test.mjs` and `bench/balance.mjs`
  - wrote `REVIEW.md`
  - **archived the change itself** to `readyset/changes/archive/2026-09-20-incremental-balance-cache/`, and merged the spec into `readyset/specs/`

  Because `proposal.md` had moved, the extension then reported *"Propose … doesn't look finished
  (proposal.md not found or empty)"* on every re-run. The review gate never appeared.
- **T11:** during *Propose* the model wrote `CHANGELOG.md`, `README.md`, `examples/basic.mjs`,
  `src/importers/csv.mjs`, `src/ledger.mjs` and three test files. The gate never appeared.
- The code in both runs is decent (hidden tests 4/4 and 5/6). **But it shipped with no human
  approval**, which is exactly what readyset promises cannot happen:
  > "nothing executes without an explicit human approve" (README)

**Why it happens (verify):** `proposeTurnPrompt` ends with *"Do not implement code in this turn —
planning artifacts only."* That is prose only. Nothing checks it, and the Propose turn has full
write/edit/bash tools.

**Direction:**
- Make it structural, not a stronger prompt. Snapshot `git status` (or file hashes) before
  Propose. After it, any change outside `readyset/` and `.ai/` means:
  - stop
  - tell the user
  - offer to revert (`git stash` / checkout) or to treat the change as a Refine
- Also detect a change directory that moved into `changes/archive/` during Propose; today that
  produces a misleading "not finished" message.
- **Verify** whether omp lets an extension restrict tools per turn (for example, remove
  `write`/`edit` or scope them to the change dir during Explore and Propose). If so, that is the
  strongest guard.
- Explore probably needs the same guard: in T12 it wrote scratch files under `/tmp`, which is
  harmless, but the same hole exists.

**How the benchmark checks it:** runs are now marked `gate-bypassed` when product code changed and
the gate was never reached. After the fix this must be **0**.

### 2. Propose is the most expensive phase and sometimes runs away

Tokens by phase across all readyset runs, parsed from `rpc.ndjson`:
- **Propose 43%**
- Apply 27%
- Explore 13%
- Review 10%
- Grill 6%

Per task:

| Task | grill | explore | propose | apply | review | calls | max ctx |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| T01 | 0.91M | 0.59M | 0.93M | 3.24M | 3.17M | 98 | 154k |
| T02 | 0.85M | 1.46M | 1.93M | 8.33M | 3.89M | 131 | 275k |
| T03* | 1.49M | 3.88M | **29.05M** | — | — | 244 | 274k |
| T04 | 0.82M | 1.01M | 2.26M | 4.91M | 2.98M | 114 | 182k |
| T05 | 1.27M | 0.73M | 2.79M | 5.94M | 3.67M | 135 | 268k |
| T06* | 0.83M | 3.32M | **13.82M** | — | — | 159 | 197k |
| T07* | 0.97M | 0.67M | 9.01M | — | — | 112 | 162k |
| T08 | 0.41M | 0.92M | 2.59M | 8.51M | 4.23M | 143 | 278k |
| T09 | 1.89M | 1.32M | 3.52M | **21.41M** | 0.31M | 183 | 313k |
| T10 | 0.89M | 0.80M | 1.93M | 2.90M | 1.93M | 93 | 168k |
| T11 | 1.32M | 4.71M | 9.83M | — | — | 146 | 260k |
| T12 | 0.90M | 6.85M | 9.84M | — | — | 168 | 171k |

\* contaminated cells; the pattern is still informative.

Observations:
- The runaway Propose numbers (T11, T12 at around 10M; T03 at 29M) line up with finding 1:
  Propose doing Apply's and Review's work.
- Cache reads are 75–91% of all tokens in every run, because all phases share one session and the
  context keeps growing (max ctx reaches 170–313k).
- **Direction:** fixing finding 1 should shrink Propose. Add a per-turn budget or tool-call cap
  for Propose (and Explore) that ends the turn with a clear message instead of burning tokens.

### 3. Scope creep

| | /plan | /readyset |
| --- | ---: | ---: |
| Code files changed | 4.7 | 5.7 |
| Lines changed | 149 | 327 |
| Files outside expected scope | 0.42 | 0.89 |

- Both judges scored `scope_discipline` at about 50% (7/4/7 planning, 6/7/5 code). It is the
  dimension readyset does not win.
- Example: T12 asked for faster balances; readyset also added a 160-line `bench/balance.mjs`. T01
  created a separate `src/services/product-sort.mjs` for a 20-line feature.
- **Direction:** the proposal should state an explicit "files this change will touch" list, and
  Apply should be told to stay inside it or ask first. Check this at the review gate.

### 4. Grounding does not measurably improve, and planning wins are length-confounded

- Judged `grounding`: 53% (5 wins, **9 ties**, 4 losses). This happens despite a 25 KB+
  `EXPLORATION.md` per change. A separate benchmark by another harness reached the same
  conclusion. That makes it the one core selling point the data does not support.
- Readyset's planning documents were **3–7× longer in every task**. It won the dimensions that grow
  with volume (requirement fidelity, completeness, verification) and tied the ones that punish
  excess (grounding, scope).
- Judges were told not to reward length, but positional swapping does not control for it. The
  planning win rate cannot yet be separated from length.
- **Direction:**
  - Make exploration findings drive concrete, checkable claims in the design (file:line anchors,
    existing helpers to reuse), rather than a long log.
  - Keep documents proportional to the change. 80 KB of planning for a 20-line change is noise,
    both for the reader and for every later turn that re-reads it.

### 5. Execution defects after a correct plan (Apply)

Each case below is a hidden test /plan passed and readyset failed, or a judge finding:
- **T11:** the deprecation used `process.emitWarning(msg, { code })` without
  `type: "DeprecationWarning"`, so it emits a generic `Warning`. The new test asserted that wrong
  name, locking the bug in.
- **T09:** error line numbers for multi-line quoted records are wrong (counts records, not
  physical lines). Apply also paused at 0/20 tasks on the first attempt, and the run then timed
  out in Code review.
- **T08** (judge): tags were de-duplicated, changing CLI behaviour the request said must not
  change.

**Direction:** these slipped past both the `_Verified:` notes and the code-review turn. Review
should check each WHEN/THEN against behaviour, not against the tests the implementer wrote (T11's
test encoded the bug).

### 6. Cost structure (from the T01 deep dive)

T01 alone: readyset 8.84M tokens against 0.36M for /plan, and 98 LLM calls against 15. Hidden
tests 7/7 against 6/7.

| Phase | Calls | Max ctx | Fresh input | Cache read | Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Grill | 27 | 49k | 343k | 558k | 12k |
| Explore | 10 | 67k | 451k | 133k | 10k |
| Propose | 11 | 93k | 300k | 603k | 22k |
| Apply | 28 | 129k | 566k | 2.65M | 26k |
| Code review | 22 | 154k | 377k | 2.74M | 52k |

Root causes:
1. **One session for all phases, so context accumulates.** Apply and Review re-send 95–154k tokens
   per call, mostly grilling transcript, explore output and drafts. Apply re-reads the artefacts
   from disk anyway.
2. **The "fresh-context code review" claim is false (verify dispatch).** The review turn ran in the
   same session at 130–154k context. The claim appears in `README.md:40`, `docs/GUIDE.md:52` and
   `:84`, the file-header comment in `readyset-review.ts:~67`, and the `codeReviewTurnPrompt` doc
   comment. The prompt also tells the model *"You did not write this implementation"*, while it
   shares the implementer's full context.
3. **`lane` is only a picker filter.**
   - It is derived by the grilling model at the *end* of grilling, from the branch type, and the
     user is never asked.
   - After that, Explore → Propose → Apply → Review are identical for both lanes. T01 was
     classified `adjust`, so full lane.
   - The result: a 20-line change gets 3 grilling rounds, a 25 KB `EXPLORATION.md`, about 80 KB
     of planning docs, 23 tasks and a mutation-testing review.
4. **Call count.** Grilling does repo research every round (17 bash and 16 read calls in T01's grill
   alone), Apply works through 23 tasks, and Review mutation-tests.

**T01 forecast** (simulated from per-call data; assumes the same calls per phase and changes only
the re-sent context):

| Scenario | Total | vs /plan |
| --- | ---: | ---: |
| Actual 0.11.2 | 8.84M | 24× |
| Compact on approve (review still in the same session) | 5.5–6.0M | 15–16× |
| + review in a truly fresh context | 4.5–4.8M | 12–13× |
| + a real fast lane (rough guess, **not** simulated) | ~1.5–2.5M | ~4–7× |

**Direction** (these also apply to the full run, where the dominant phase is Propose, not Apply):
- **Compact on approve by default.** It's safe: every artefact is on disk and Apply re-reads it.
  Keep an explicit "Approve & Execute, keep context" option. `ctx.compact()` and
  `compactBeforeExecuteGuidance` already exist.
- **Review in a genuinely fresh context** (diff + specs + tasks only). If omp's extension API
  cannot do that, **fix the documentation** instead of claiming it. **Verify** the API options
  (subagent/task tool, `newSession`, `handoff`) before promising anything.
- **Make lane real and decide it up front:**
  - the model proposes a lane as grilling's first question; the user confirms or overrides;
    `--lane` forces it
  - fast lane: 1 grilling round, Explore folded into Propose, at most ~8 tasks, review without
    mutation testing
  - clear tasks gained only +8 pt for 10× the cost, which is the case for it
- **Research once before grilling round 1**, not every round. Cap tool calls per round.

### 7. Keep this: grilling is the thing that wins

- **T10 (+50 pt):** grilling surfaced Jakarta-time month bucketing, transfer/refund exclusion and
  gap-month filling. /plan asked nothing and guessed wrong on all three.
- **T01:** grilling round 1 asked how an empty `?sort=` should behave. The user said "treat as
  absent". /plan assumed "empty → 400" and failed that hidden test.
- **T02, T05, T08:** readyset passed hidden tests on semantics /plan guessed (coupon rules, legacy
  priority defaults, backup never overwritten).
- /plan asked the user a question in 1 of 12 tasks; readyset averaged 3.2.
- **Guardrail for every change above:** cut *volume* (research, turns, tasks, document size,
  context), **never** the behaviour-affecting questions.

---

## Corrections to earlier roadmap drafts

- **Don't forbid Propose from writing to `EXPLORATION.md`.** `proposeTurnPrompt` deliberately has
  Propose append an "Additional findings (Propose turn)" section for provenance. Forbid rewriting
  or replacing it, not appending.
- **"Send all grilling questions in one turn" saves nothing.** Rounds already batch up to 4
  questions. Grill's cost comes from repo research per round, not from round count.
- **Compaction alone is about −32 to −38% on T01, not −45%.** Anything beyond that needs lighter
  prep or fewer calls.
- **The old guess that "Apply is the biggest phase" came from T01 only.** Across the run, Propose is
  the biggest, and it is tied to finding 1.

## Suggested order

1. **Gate integrity** (finding 1). This comes first because it is a broken product guarantee, not a
   cost issue. It will probably also shrink Propose's cost (finding 2).
2. **Honest docs** for the review claim (finding 6, root cause 2): a small fix, immediately.
3. **Compact on approve by default**, plus a per-turn budget for Propose and Explore.
4. **Scope control** (finding 3) and review checking behaviour rather than the implementer's own
   tests (finding 5).
5. **Fresh-context review** (needs an API decision first).
6. **Real lane and fast lane.** This is the biggest cost win for small tasks and the riskiest.
   Validate it on the ambiguous tasks. Don't do it in the same release as step 5, or you can't
   attribute the effect.

## How to verify with the benchmark

```bash
# in readyset-bench, after the readyset-flow changes are in the checkout bench.config.json points at
./preflight.sh
./run.sh --label <new-label>        # ONE process; runsPerCell: 3
./compile.sh --label <new-label> && ./bench.sh --label <new-label> && ./insights.sh --label <new-label>
```

Success criteria:
- `gate-bypassed` = 0
- hidden-test pass rate not lower than the /plan arm on the ambiguous tasks (T04, T07, T10)
- tokens and wall time down, checked per phase in `improve.md` §5
- planning-length ratio down (report → *Verbosity check*) without losing planning verdicts
- scope: files outside expected scope ≤ the /plan arm

Use the /plan arm of the new run as the baseline, not `deepseek-r1`: the old label is contaminated,
and the harness itself changed since.
