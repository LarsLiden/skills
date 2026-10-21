---
name: statusreport
description: "Produce a concise, evidence-grounded work status table with work item names, descriptions, original conversation estimates when available beside remaining agent-time estimates or Done, and a total remaining estimate. Use for /statusreport, progress summaries, remaining-work estimates, and status updates. Defaults to the current conversation's task or workstream; accepts an explicitly named scope. Read-only: never starts or resumes work."
---

# Status Report

## Purpose

Give the user a useful snapshot of what is done, what is underway, what remains,
and roughly how long an agent would need to finish it. Report agent completion
time, not human development hours, billing, or a promised delivery date.
Show each item's earliest recorded estimate from the conversation beside its
current remaining estimate when available.
This personal skill works across projects without project-specific adapters.

## When to Use

- The user invokes `/statusreport`.
- The user asks for a work-status table or estimated remaining agent time.
- The user names a task, workstream, project, or session to summarize.

## When Not to Use

- Implementing, resuming, testing, approving, or publishing the reported work.
- Starting recurring monitoring or creating agents, sessions, or automations.
- Producing actual usage, cost, or historical time accounting.

## Inputs

| Input | Required | Meaning |
|-------|----------|---------|
| Scope | No | Defaults to the current conversation's task or workstream, including its known unfinished deliverables. An explicit named scope overrides this default. |
| Evidence pointers | No | User-provided session, plan, issue, PR, task list, or result references that narrow the lookup. |
| Detail preference | No | Defaults to a concise milestone-level table; expand when requested or necessary to expose distinct blockers. |

Examples: `/statusreport`, `/statusreport object pipeline`, or
`/statusreport all active work in this project`.

## Workflow

### 1. Resolve the scope

Use the latest relevant task and approved scope in the conversation. Do not
silently broaden a feature report to the entire repository or every active
session. In a side chat, resolve an explicitly named workstream using available
read-only history and session metadata.

If multiple plausible targets remain, ask one focused scope question using
the available question tool. Do not invent a task list for an empty conversation.
Honor repository access restrictions; a target name does not authorize reading
prohibited worktrees or unrelated private files.

### 2. Gather the smallest sufficient current evidence

Start with the conversation and its referenced plan or durable task tracker.
Read only the relevant sections and nearby dependencies. When past work or
another session matters, use available session-history search, time-bound it
initially to seven days, and narrow by known session or reference before
expanding. Do not scan all transcripts or rediscover an already identified
target.

For claims about live session activity, refresh supported session-status tools
(such as `get_session` or `get_sessions_status`) before reporting. A busy badge
shows activity, not which milestone is complete; an idle badge is not Done.
When needed and permitted, inspect relevant diffs, existing verification
receipts, and current PR or issue state without changing them. Do not fetch,
checkout, build, run tests, render, or contact workers merely to make a report.

Distinguish:
- Verified completion from a plan's unchecked or stale status.
- Implementation complete from required verification or delivery still pending.
- An observed blocker from a suspected limitation or missing evidence.
- Current observations from historical reports with an older timestamp.

If sources conflict, state the discrepancy rather than silently choosing the
more optimistic result. If live access is unavailable, give a clearly labeled
last-known report with its known timestamp, or say freshness is unknown.
Missing visibility is not itself proof that the underlying work is blocked.
Include a few concise source references for consequential claims; use actual
returned session URLs and observed file/PR links, never invented links.

### 3. Build nonoverlapping work items

Use the existing plan's meaningful work packages, names, and ordering when
available. Include relevant completed milestones for context, the active
increment, and known remaining work. Avoid file-by-file noise or unrelated
project backlog.

Give each item a short description with a clear state: Done, In progress,
Not started, Blocked, Awaiting verification, or Status unknown. Put the state
in the description so the report needs only four columns, including the
original estimate beside the current remaining estimate.

Mark Done only when the item's own required completion boundary is supported.
Do not invent additional gates, but never hide required unfinished verification,
review, integration, or delivery behind a Done label. A parent and its child
items must not both contribute to the estimate. Count shared work once.
Keep optional, canceled, and out-of-scope work outside the required total;
label exclusions if they are important to understanding the report.

### 4. Recover original estimates from the conversation

For each item, use the earliest explicit estimate for that same work item in
the scoped conversation, not the latest revision or the estimate being made
for this report. Match the actual deliverable and completion boundary, not
just a similar name. Use visible messages first; if relevant earlier messages
are missing, use the bounded, read-only history lookup from step 2 for that
conversation. Do not scan unrelated sessions.

- Preserve the original value or range, units, and stated time basis. Do not
  recalculate it, subtract elapsed time, or replace it with a later estimate.
  An earlier explicit **Unknown** remains **Unknown**.
- If no earlier estimate is found, display **Not recorded**. If history is
  unavailable or incomplete, say so briefly; do not claim that no estimate
  was ever given or invent one from elapsed time, current effort, or a summary.
- Keep the original estimate for completed items; only their current remaining
  column becomes **Done**.
- If the same identifiable item's scope or completion boundary materially
  changed, retain the historical estimate with **(scope changed)** and briefly
  explain why it is not directly comparable. Preserve a differing time basis
  with the same warning; never silently treat calendar time or human hours
  as agent effort.
- Do not assign a parent's estimate to its children, divide it among new rows,
  or combine historical estimates for merged items. Without a direct match,
  display **Not recorded**.
- Cite the earlier message or report compactly using an available reference
  or recorded timestamp. If the earliest recorded estimate was made after
  work began, identify it as such rather than claiming it was a full-task
  starting estimate. If earlier history is missing, label any retrieved value
  as the earliest available rather than claiming it is definitively the first.

Historical estimates are context, not actual elapsed time or permission to
resume work. Missing original estimates do not prevent a current report.

### 5. Estimate remaining agent completion time

Estimate only unfinished work, including remaining implementation, debugging,
tool execution, and required verification or delivery within the approved
scope. Use coarse ranges grounded in the known work and available comparable
results. These are judgment estimates unless actual measurements support them;
do not present them as measured throughput.

Use a consistent single-agent-equivalent basis. Necessary build, test, or
provider execution time may be part of completing the item; exclude time
waiting for human decisions, resource admission, provider outages, and other
external blockers. State this distinction briefly in the report.

- Use minutes for small items and hours for larger items. Avoid false precision.
- In the remaining column, Done contributes zero and displays **Done**, not a
  numeric estimate; its original estimate remains historical context.
- Widen or flag low-confidence ranges for poorly explored downstream work.
- For blocked work, give a conditional active-work estimate only when the
  remaining scope is understood, and name the unblock condition.
- If scope or completion requirements are too uncertain, use **Unknown**.
  Never replace unknown effort with zero or a made-up number.
- Do not mechanically subtract elapsed time from a prior estimate; reassess
  the remaining work using current evidence.
- Do not turn an estimate into permission to start work or a commitment to
  meet a deadline. Do not infer model speed or a parallel worker count.

### 6. Calculate an honest total

Normalize ranges to one unit before summing. Add the lower bounds and upper
bounds of distinct required unfinished items separately; sanity-check the
arithmetic. Never add a subtotal and its component rows again.
Sum only the current remaining estimates, never the original-estimate column.
Missing or unknown original estimates do not make a fully estimated remaining
total a subtotal; unknown current remaining work still does.

The sum is remaining agent effort on a single-agent-equivalent basis, not
calendar time to completion. With concurrent agents, do not divide by worker
count or claim a wall-clock ETA without an explicit dependency and scheduling
analysis. No such analysis is needed for this skill's default report.

If any required item is unestimated, label the sum a **known subtotal** and
state how many required items remain unestimated; the full total is unknown.
If all scoped work is verified complete, report **Done (0 remaining agent-hours)**.
Do not claim zero when the task list or completion evidence is unavailable.

### 7. Render the report and stop

Lead with one or two sentences describing the most important current state.
Briefly state the estimate basis and significant exclusions. Add source links
compactly before the table or before the final total.

Use this shape, replacing every placeholder with scoped evidence:

```markdown
**Current status - <scope>:** <main completed milestone, active work, and key blocker if any>.

Rough single-agent completion estimates, including remaining implementation,
debugging, and required verification; excluding approval delays, queues, and outages.

| Work item | Description / current status | Original estimate | Remaining agent time |
| --- | --- | --- | --- |
| <completed milestone> | **Done.** <supported result> | <earliest recorded estimate or Not recorded> | **Done** |
| <active milestone> | **In progress.** <remaining work> | <earliest recorded estimate or Not recorded> | **<low>-<high> hours** |
| <later milestone> | **Not started.** <bounded deliverable> | <earliest recorded estimate or Not recorded> | **<low>-<high> hours** |

<Only if useful: a short dependency, confidence, freshness, or estimate-comparability note.>

**Total estimated remaining: <sum low>-<sum high> agent-hours.**
```

For incomplete estimates, replace the last line with:
`**Known remaining subtotal: <range> agent-hours; <count> required items unestimated. Full total unknown.**`

Keep the total as the last content unless a higher-priority instruction requires
a status footer. Do not append an offer to continue, a follow-up question,
an implementation plan, or unsolicited next steps. Reporting does not modify
files, task status, claims, approvals, or running work.

## Validation

- [ ] Scope matches the current workstream or the user's explicit target.
- [ ] Every state has evidence or is clearly identified as unknown/last-known.
- [ ] The table has work item, description/current status, original estimate, and remaining agent time, with the two estimate columns adjacent.
- [ ] Originals use the earliest explicit same-item conversation estimates, retain their units/basis, and have compact source references.
- [ ] Missing originals display Not recorded; incomplete history and scope/basis changes are disclosed without inventing estimates.
- [ ] Completed items retain their originals; split/merged items do not inherit unmatched estimates.
- [ ] Required incomplete gates are visible; Done is not inferred from inactivity.
- [ ] Estimates describe agent work, use ranges, and disclose excluded waits.
- [ ] Totals sum only current remaining estimates for distinct required unfinished work in compatible units.
- [ ] Unknown current remaining items prevent an apparently complete numeric total; missing originals do not.
- [ ] No workers were awakened and no execution or mutation was performed.

Sanity cases: two unfinished items of 1-2 and 2-4 hours total 3-6 agent-hours;
30-60 minutes plus 1-2 hours totals 1.5-3 agent-hours; adding a Done row changes
neither sum. Adding an unestimated required item makes either sum a known
subtotal, not a full total. A blocked but scoped item retains its conditional
effort estimate; its unknown wait is not counted as zero calendar time.

Original-estimate sanity cases:

| Earlier conversation evidence | Expected report |
| --- | --- |
| Same item first estimated at 2-4 hours, then revised to 1-2 hours; current remaining estimate is 30-60 minutes | Original stays 2-4 hours; remaining is 30-60 minutes. Only remaining contributes to the total. |
| Same item originally estimated at 2-4 hours and now verified complete | Original stays 2-4 hours; remaining displays Done and contributes zero. |
| No earlier estimate for the item | Original displays Not recorded; current remaining is estimated normally. |
| Earlier messages cannot be retrieved | Original displays Not recorded, with a history-unavailable note; do not assert that no estimate was ever given. |
| Same identifiable item has materially changed scope since its 2-4 hour estimate | Original displays 2-4 hours (scope changed); explain the mismatch rather than implying a like-for-like comparison. |
| Only a parent estimate exists for newly split child items | Children display Not recorded; do not divide or duplicate the parent's original estimate. |
| Earlier estimate is explicitly Unknown, or uses a different time basis | Preserve Unknown or the stated value and basis; flag a differing basis as not directly comparable. Neither affects the current total. |

## Common Pitfalls

| Pitfall | Correction |
|---------|------------|
| Repeating the last report as if it were fresh | Refresh relevant evidence or label it last-known. |
| Replacing an original estimate with the latest revision | Keep the earliest explicit same-item estimate; reassess only current remaining work. |
| Comparing changed scope or inventing a missing baseline | Flag scope/basis differences and unavailable history; use Not recorded when no matching estimate is found. |
| Treating implemented, merged, or idle as automatically Done | Check the actual item's required completion boundary. |
| Giving human-sized estimates or confident dates | Use rough agent-time ranges; separate effort from elapsed time. |
| Double-counting stages and a parent pipeline | Estimate one disjoint level and count shared work once. |
| Omitting uncertain stages to make a reassuring total | Keep them visible and label the numeric sum a known subtotal. |
| Turning a status request into execution | Read existing evidence only; leave work and authority unchanged. |
