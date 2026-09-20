# Readyset cost efficiency — findings from benchmark run `deepseek-r1` / T01

Context for whoever picks this up (human or agent): these findings come from the first
end-to-end benchmark of `/readyset` against omp's native `/plan`, run in the `readyset-bench`
harness. Treat them as **hypotheses to verify in code**, not settled facts. They rest on a single
task (T01) and a single rep. Everything that says "verify" has not been checked against the
readyset source yet.

## Setup

- Task T01: add `?sort=price_asc|price_desc|name` to `GET /products` in a small Node API. This is a
  small, clear feature; the reference solution is about 20 lines.
- Both arms used the same model for planning and execution: `eai1/cbai/deepseek-v4.1-flash`,
  omp 18.2.0, readyset 0.11.2.
- Both arms ran headless over omp RPC. A simulated user answered questions from a hidden persona,
  and each arm's approval step was auto-approved.
- Grading: 7 hidden tests on the final code, plus the repo's own suite.

## Headline

| | /plan | /readyset 0.11.2 |
|---|---:|---:|
| Hidden tests | 6/7 | **7/7** |
| Wall time | **1m18s** | 14m56s (11×) |
| Tokens (total) | **0.36M** | 8.84M (24×) |
| LLM calls | 15 | 98 |
| Max context per call | 29k | 154k |
| Output tokens | 5.7k | 122k |

**Quality:** readyset won on the one hidden test that mattered. In grilling round 1 it asked how an
empty `?sort=` should behave, and the user's answer was "treat as absent". /plan asked the user
nothing, assumed "empty → 400", and got it wrong. This is exactly what grilling is for, so any
cost cut must not remove it.

**Cost:** 24× the tokens for a 20-line change. The rest of this document explains where the
tokens went.

## Where the tokens went (readyset, per phase)

| Phase | Calls | Max ctx | Fresh input | Cache read | Output |
|---|---:|---:|---:|---:|---:|
| Grill | 27 | 49k | 343k | 558k | 12k |
| Explore | 10 | 67k | 451k | 133k | 10k |
| Propose | 11 | 93k | 300k | 603k | 22k |
| Apply | 28 | 129k | 566k | **2.65M** | 26k |
| Code review | 22 | **154k** | 377k | **2.74M** | 52k |
| **Total** | **98** | | 2.04M | **6.69M (76%)** | 122k |

The baseline context (system prompt, tools and first prompt) is 15.7k tokens. /plan: 15 calls,
max context 29k.

## Root causes, ranked by impact

### 1. One session for every phase, so context accumulates (largest driver)

Grill, Explore, Propose, Apply and Code review all run as turns in the same omp session. Every LLM
call re-sends the whole history. By Apply, each call carries 95–130k tokens, mostly grilling
transcript, explore bash output and draft documents. None of that is needed, because Apply
re-reads the artefacts from `readyset/changes/<id>/` anyway. That is 76% of all tokens, spent as
cache reads.

### 2. "Fresh-context code review" isn't fresh

README and GUIDE describe a fresh-context code review. In practice the review turn ran in the same
session at 130–154k context, so the reviewer inherited everything the implementer saw. That makes
it both the most expensive phase and a claim the product doesn't meet. **Verify** in
`src/extensions/readyset-review.ts` (`codeReviewTurnPrompt` / the review `spendTurn`) how the
review turn is dispatched.

### 3. `lane` doesn't change the workflow

- `lane: full|fast` is derived by the grilling model **at the end** of grilling, from the branch
  type (feature/adjust/experimental → full; bugfix/refactor/chore/… → fast). The user is never
  asked.
- After that, lane only filters the brainstorm picker (`--fast` includes fast-lane items).
- Explore → Propose → Apply → Review are identical for both lanes. T01 was classified `adjust` →
  full.

So there is no light path: a 20-line change gets 3 grilling rounds, a 25 KB `EXPLORATION.md`,
5 planning documents (about 80 KB), 23 tasks each with a `_Verified:` note, and a review that
does mutation testing.

### 4. Call count

98 calls against 15. Sources: grilling does repo research every round (17 bash and 16 read calls
during grill alone); Apply works through 23 tasks; Review runs mutation tests.

## Forecast for T01 (simulated from per-call data)

Assumption: same calls and work per phase; only the re-sent context changes. The compaction
summary is assumed to be 10–20k, plus one summarizer call (reads about 93k, writes the summary).

| Scenario | Prep | Compaction | Apply | Review | **Total** | vs /plan |
|---|---:|---:|---:|---:|---:|---:|
| Actual 0.11.2 | 2.43M | — | 3.24M | 3.17M | **8.84M** | 24× |
| Compact on approve (review still same session) | 2.43M | 0.10M | 1.32–1.60M | 1.64–1.86M | **5.5–6.0M** | 15–16× |
| + review in a fresh context | 2.43M | 0.10M | 1.32–1.60M | 0.65M | **4.5–4.8M** | 12–13× |
| + real fast lane (rough guess, not simulated) | | | | | **~1.5–2.5M** | ~4–7× |

Compaction and fresh review together cut about 45–50%. Getting further needs lighter prep and
fewer calls, which is what a real fast lane would provide.

## Recommended changes for 0.12, in priority order

1. **Compact by default on approve.**
   - Make "Approve & Execute" compact first (it's safe: every artefact is on disk and Apply re-reads
     them).
   - Keep an explicit "Approve & Execute, keep context" option for when discussion nuance didn't
     make it into the artefacts.
   - Alternative: compact automatically only above a context-usage threshold
     (`ctx.getContextUsage()` is already available). An explicit default is easier to reason
     about.
2. **Run code review in a fresh context.** Use a subagent or new session that receives only the
   diff, the specs and `tasks.md`. This fixes the false claim and removes the most expensive
   phase. **First verify** what omp's extension API offers for this (subagent/task tool,
   `handoff`, new session). Don't assume.
3. **Make `lane` real, and decide it up front.**
   - The model proposes a lane with a reason as grilling's first question; the user confirms or
     overrides; `--lane fast|full` forces it.
   - Fast lane:
     - grilling: 1 round, behaviour-affecting ambiguities only
     - Explore: merged into Propose
     - Propose: short proposal plus at most about 8 tasks
     - Review: no mutation testing, fresh context
   - Guardrail: the fast lane must still ask the behaviour questions. In T01, the empty-`sort=`
     question is what beat /plan.
4. **Trim grilling research.** Research once before round 1, not every round. Cap tool calls per
   round.
5. **Keep planning documents proportional.** 80 KB of planning for a 20-line change is noise, both
   to the reader and to every later turn that re-reads it.

## How to measure (don't trust the forecast, measure)

- Harness: `playground/readyset-bench`. Compare against label `deepseek-r1` (0.11.2 baseline).
- Develop 0.12 in a separate git worktree. The running benchmark loads the extension live from
  `playground/readyset-review`, so editing it mid-run corrupts results.
- After merging, run the readyset arm under a new label and compare to the baseline's /plan
  results:
  ```bash
  ./run.sh --reps 1 --label deepseek-r1-v0.12 --arms readyset
  ```
- Report tokens split into **fresh input / cache read / output**, not only a total. Cache reads
  are much cheaper, and a single total overstates readyset's real cost.
- Success criteria:
  - hidden-test pass rate does not drop against 0.11.2, especially on the ambiguous tasks
    T04/T07/T10
  - tokens and wall time drop by a measured amount
  - lane is recorded per run so results can be split by lane

## Caveats

- n = 1 (one task, one rep, one model). Redo this analysis once all 12 tasks finish under
  `deepseek-r1`.
- The forecast assumes the call count per phase is unchanged; compaction may itself change model
  behaviour.
- The simulated user sometimes answers sloppily (it replied "1A 2A 3A 4A" to a one-question round).
  This had no effect on T01.
