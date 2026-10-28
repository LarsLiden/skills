# Telegram bridge implementation and development

Start with [README.md](README.md) for installation on a new computer, bot setup,
phone pairing, updates and troubleshooting. This document describes the runtime
contracts and verification boundaries.

A Windows personal extension for Copilot app sessions across projects.
Ordinary questions can be answered from Telegram; plans, permission prompts and
MCP forms remain in Copilot. No model, public server, inbound internet listener,
paid messaging service or recurring AI session is used.

## Setup

1. Load this user extension in a fresh Copilot app chat and open the **Telegram
   bridge** canvas. Keep that chat as the hub; it cannot monitor itself.
2. Create a dedicated bot in Telegram with `@BotFather` and `/newbot`.
3. Enter the bot token in the panel's password field. **Never paste it in agent
   chat, a command line or source.** Click **Save token and connect**.
4. Generate a pairing link, open it on your phone and press **Start**. Confirm
   the displayed account ID in the local panel. Only private chats are accepted.
5. Refresh sessions and explicitly select those you want to monitor.

Bot creation and phone pairing are one-time setup. On later opens, the panel
shows the saved bot and phone pairing instead of asking for another token.
If disconnected, click **Connect saved bot** to resume with the existing pairing
and session selections. Session checkboxes, **Refresh sessions** and idle-notice
settings are disabled until connected; existing selections remain saved.
Unavailable saved selections remain listed by their last known name and alias,
with a red **\* Unavailable** marker. The marker clears when the session becomes
visible again. While connected, you can deselect a missing session to stop
monitoring it and, when topics are enabled, permanently delete its Telegram
topic and message history.
The status distinguishes disconnected, pairing required,
paused and active monitoring; no available selected sessions is shown explicitly.
An app-status failure leaves the session list unverified; zero loaded sessions
does not mean saved selections were removed. Adapter errors identify the returned
result classification and recognized response fields without including response
text, tool arguments or credentials. An unsupported response is not evidence of
a permission denial. The read-only **check_app_connection** canvas action checks
this app connection without connecting Telegram or running a monitoring sync.
**Replace saved bot** reveals the token form only when you deliberately want
to change bots. Saving a replacement clears pairing and session selections;
canceling leaves the saved configuration unchanged.

Opt-in sends session names, question text, choices and captured answers to Telegram.
After a phone message or answer, it also forwards the first public assistant reply.
When idle notifications are enabled, it sends the latest public final reply as well.
Bot chats are not end-to-end encrypted. Do not opt sensitive sessions in.
Whole conversations, reasoning, files and tool arguments are not forwarded.
Phone notifications still depend on Telegram and the phone's notification/Focus settings.

## Phone controls

- Tap a question's choice button, or use Telegram **Reply** on that question.
- In a session topic, type an ordinary message or use **Reply** on a non-question
  message; no `/tell` prefix is required. After a new message or question answer,
  the first public reply appears as **\* REPLY \*** as soon as captured.
  The existing **\* IDLE \*** final result still follows when the session becomes
  idle. The immediate app-acceptance acknowledgment is not Copilot's answer.
- `/status` lists opted-in sessions and their three-digit numeric codes.
- `/tell 042 Your instruction` sends a new message to that exact opted-in
  session, unless it is currently awaiting a decision.
- `/help` describes the commands. There is no broadcast or blanket approval.

### First reply after a phone message or answer

The first-reply listener waits for the agent's first complete public message,
not for the whole job to finish. A public progress preamble can qualify even
when the same message invokes tools; only its public text is sent, never tool
arguments, reasoning or subagent output. Streamed text waits for the matching
terminal message, so partial sentences are not pushed as separate notifications.
If the first public response is a native task-completion summary, its original
completion-event ID is retained instead of inventing a message ID. It must follow
the correlated root turn without an intervening unrelated input; forwarding it
does not assert the task succeeded.
The existing final-result notification remains independent. If the first reply
is already the final answer, the later idle notification can contain that same
answer; the idle marker reports a separate transition, not another agent response.

Each phone input is recorded before app dispatch, using a text hash rather than
storing the incoming message. New-message capture requires the exact hub source,
matching consumed user text and native message/interaction/turn identity.
Question answers require the exact question-completion ID and matching answer
hash, followed by its resumed model turn. This also catches fast replies emitted
before the app acknowledgment, but nothing is sent until app acceptance is
confirmed. Missing or ambiguous correlation is not guessed; capture errors appear
in the owning session's log. A separate local message or unrelated interaction
ends the earlier first-reply capture. Several phone inputs consumed together can
share one public response without sending duplicate copies.
Before delivery, an exact app lookup must still confirm the session is available
and not archived/deleted; a failed lookup withholds the reply rather than sending
from stale session metadata.

The hub watches the local first-reply directory and delivers through its existing
serialized queue. No recurring AI task or new agent is used, and no status scan
is required for prompt delivery. The normal 15-second scan also picks up a saved
capture if a filesystem notification was missed. It does not retry attempted or
uncertain sends. Multipart replies preserve the exact paired chat and session
topic, with a durable before-send record and positive Telegram message receipts.
Uncertain app input and first-reply delivery appear separately in unresolved status.

This feature requires reloading the extension in the hub **and each monitored
session**, or a user-performed whole-app restart when safe. A hub-only replacement
does not update existing capture listeners. Do not replay old Telegram inputs to
activate it. New first replies do not depend on the optional idle-notice toggle;
the final-result notification still follows that toggle.

### Answered questions

The bridge edits the original question message to show **Answered** and the
actual answer, removing its choice buttons. This applies to confirmed answers
sent through Telegram and captured answers entered in Copilot. Updating an answer
does not delete the question or move it to another topic; retiring the whole
session topic later deletes its history under the cleanup policy below.

App-side capture uses the session's `user_input.completed` event and binds the
answer to the exact retained request, bot, phone and selection. Only questions
already forwarded for an opted-in session are captured; idle notifications do
not need to be enabled. Plans, permission prompts, forms, subagent events and
unrelated responses are excluded. Updates appear on the normal monitoring scan,
usually within 15 seconds while the bridge is healthy.

If a question is no longer active but its answer was not captured, the message
says **Answer unavailable**, not "Answered". A later matching receipt can replace
that label. Events missed while the listener is offline are not reconstructed
from transcripts. An unusually long freeform answer shows an explicitly labelled
preview if the question and answer exceed Telegram's 4,096-character limit; the
full answer remains in Copilot.

After installing this feature, reload the extension in both the hub and each
monitored session, or restart Copilot when those sessions can safely be
interrupted. Reconnect the saved bot after the hub restarts. Reopening the setup
panel alone does not load new listener code.

An edit failure is reported separately as `question-update-uncertain`; a confirmed
app answer stays recorded even if its Telegram display could not be updated.
Uncertain edits are not automatically retried, and a display problem never causes
the bridge to submit the answer again.

## Private session topics

Use your existing bot and pairing; no group or new bot is required. Enable
private-chat topics for the bot in BotFather, then click **Enable session topics**
in section 4 of the local panel while connected and paired. The bridge checks
Telegram's `getMe.has_topics_enabled` capability before changing its routing.
Opening the panel or reconnecting alone does not activate this feature.

The bridge creates **Bridge** for general information and a topic named
`Session name` for each selected session, without a numeric prefix. Question notifications,
app-only alerts and every part of an idle reply go to that session's topic.
Topic mappings are saved against the exact bot, paired chat and permanent
Copilot session ID, not the display name. Session renames update the topic
title without changing its identity. After confirmed deletion, deliberately
selecting that session again creates a new topic with the same session code.

In-topic message headers show only the session name, including questions,
answered-question updates, app-only alerts and idle replies. The three-digit code
remains in `/status` and the setup panel for explicit `/tell 042 ...` use from
Bridge. Sessions with the same display name still have distinct topics and routing;
use `/status` to distinguish their codes. Messages outside session topics retain
their numeric heading for context. Existing topics are renamed in place on the
next connected sync with the updated hub; their history and routing IDs are unchanged.

If Android still shows one mixed conversation after enabling topics, return to
Telegram's main chat list and reopen the bot conversation. This made the named
session topics visible in live use; recreating the topics was not necessary.

- In a session topic, ordinary text and non-question replies address that session.
  `/tell Your instruction` remains optional. An explicit matching three-digit code also works; a code for another
  session is rejected. Use Bridge for `/tell 042 Your instruction` across sessions.
- `/status` in a session topic reports that session. In Bridge it lists all
  selected sessions. Command replies stay with the originating conversation.
- Answer a question with its buttons or Telegram **Reply**. The original question,
  message and topic must all match; plain "yes" is not interpreted as approval.
  Retained stale question replies are rejected, not converted into new instructions.
- For ordinary messages and non-question replies, the current topic's saved
  session binding supplies the destination. No latest-idle-message receipt is
  needed, including when replying to older idle notifications. Quoted text is
  not sent to Copilot; only the user's new text is sent. Contradictory quoted
  thread metadata is rejected rather than redirecting the message.
- The app is rechecked before every new instruction. A pending question, plan or
  permission must still be answered through its proper path; plain text cannot
  approve it. Unknown slash commands are not forwarded as prompts; use `/tell`
  followed by the literal text if the message itself must begin with `/`.
- Deselection blocks control and permanently deletes the session topic and its
  messages. Selecting it again after confirmed deletion creates a fresh topic.
  Deleted thread identities remain locally recorded so old buttons and replies
  cannot target the replacement. A new session never inherits another's code.
  Archived or unavailable Copilot sessions cannot receive instructions.

Existing Telegram history is not moved or copied. Automatic cleanup deletes only
eligible session topics as described below. Already-issued pending questions keep
their original reply location until that topic is retired; they are never moved
to a replacement topic. The usual stale/restart checks still apply.
Topics cannot authorize plans, permissions, groups or unpaired users.
The bridge does not use the group-only topic close/reopen methods in private chats.

Topic creation, renaming and deletion write an attempt record before calling Telegram.
Lost or ambiguous results remain visible and are never automatically retried.
**Sync session topics** can retry a definitive Telegram rejection after its cause
is fixed; it does not override an uncertain outcome. A failed creation blocks
that destination rather than sending its messages to the main chat. Other ready
sessions can continue. An uncertain rename retains the original topic ID and
shows the title problem separately.

### Automatic topic cleanup

While connected, the bridge deletes topics for sessions you deselect and sessions
the app explicitly confirms are archived or deleted. **Deletion permanently
removes the topic and all its Telegram messages.** This also applies to previously
deselected `Inactive` topics on the first connected scan after loading this policy.
The Bridge topic and selected active/idle sessions are never cleanup candidates.

An absent list entry, unavailable session, not-found response or failed app lookup
is not deletion evidence. The bridge tries exact same-ID session metadata for a
missing selected session, retaining its topic if closure cannot be confirmed.
The panel reports unverified closure; if the app cannot distinguish a deleted
session from an unavailable one, deselect it manually to authorize cleanup.

Deletion uses the saved bot/chat/thread binding and requires a positive Telegram
response. Local receipts retain the reason, attempt, completion and retired thread
IDs. A failed or interrupted deletion blocks that destination, never reroutes its
messages to Bridge, and never clears uncertain answer/notification records.
**Sync session topics** retries only a definitive rejection; an unknown outcome
requires inspection and is not automatically retried. Re-selection is blocked until
deletion is confirmed, after which it creates a new topic without reviving old
questions, buttons or uncertain app answers. Retiring a topic does not archive,
stop or modify the Copilot session itself.

Topic cleanup and notification wording run in the hub. Loading changes to them
requires only a hub restart/replacement and local reconnection, not another restart
of the monitored sessions.

Do not manually delete bridge topics while they are in use. A missing topic
surfaces a send failure, not automatic replacement or history loss. Uncertain
topic records require inspection; this version does not provide a manual
topic-rebinding interface. If topic mode is disabled in BotFather after activation,
reconnection refuses until it is restored.

API references: [private-chat topics](https://core.telegram.org/bots/features#topics-in-private-chats),
[createForumTopic](https://core.telegram.org/bots/api#createforumtopic),
[editForumTopic](https://core.telegram.org/bots/api#editforumtopic),
[deleteForumTopic](https://core.telegram.org/bots/api#deleteforumtopic),
and [sendMessage](https://core.telegram.org/bots/api#sendmessage).

## Session codes and question safety

Replace `042` with the code shown in the panel or `/status`, including leading
zeros. Existing longer aliases are migrated once to three-digit codes; old
longer codes are rejected, never truncated. Phone pairing, selections and
question/reply bindings are preserved.

Codes are stable across restarts and deselecting/reselecting a session. Retired
codes remain reserved for their original session, even when changing bots.
The available range is `000` through `999`; if all codes are reserved, selecting
a new session fails visibly rather than reusing another session's code.
**Forget token, phone and session selections** clears these reservations along
with the rest of the saved bridge configuration.

Answers are bound to the exact original session, request and question/choices.
Stale, resolved, revoked, duplicate and previously attempted answers cannot run.
The app is checked again before answering and enforces its own request ID.
An acknowledgment says only that the app accepted the answer/message, not that
the task completed. An app write without a confirmed result is marked uncertain,
retained locally and never automatically replayed.

## Lifecycle and limitations

### Incoming receipts and transport health

Before routing an authenticated paired-account update, the hub atomically saves
its update watermark and an `inbound` receipt. Receipt fields include Telegram
update/message/topic/reply IDs, bot/chat, receipt time, Telegram date, kind and a
content hash. Incoming text and callback payloads are not retained. Foreign,
forwarded, group and bot-sender data does not enter this history. Destination and
exact question identity are saved before app preflight; app attempts are saved
before dispatch. Validation/rejection responses explain non-dispatch. A failed
app preflight records a not-sent outcome and attempts one failure notice.

Receipt outcomes distinguish `received`, `attempting`, `accepted`, `uncertain`,
`not-sent`, `handled` and `interrupted`. Accepted app writes are not reclassified
when Telegram confirmation fails. Button acknowledgment runs after routing, so
an `answerCallbackQuery` network failure cannot prevent a valid exact answer.
It does not authorize stale/foreign replies or retry any app action. The original
request/command and first-reply receipts remain authoritative for their effects.

On load, unfinished received inputs become interrupted and saved app attempts
become uncertain; neither is replayed. The watermark is assigned in memory only
after a successful save. A state-save failure pauses incoming processing,
terminates the current receiver/monitor and requires inspection before a new
runtime, rather than polling with a higher offset. A possibly committed save is
not retried to guess its outcome. The panel reports the pause explicitly.
Completed error-free inbound history is bounded to 200 records; failures,
interrupted and uncertain records are retained. The panel and read-only canvas
status show the latest 20. Records cannot establish delivery of older inputs
that were never journaled, and reconnect's explicit discard boundary is unchanged.

`health` separates current-runtime `poll`, `monitor`, `inbound`, `reply` and
`action` errors and observations. Polling records the attempted offset, latest
batch size, last attempt/success/failure, consecutive failures and recovery.
Successful app monitoring never clears polling failure, and a successful poll
does not clear an app dispatch failure. A recovered fault recurring later produces
a fresh warning. These health observations are in-memory, not reconstructed
historical delivery evidence; unresolved durable action records survive recovery.

Telegram failures identify only allowlisted method/stage/code, timestamp and HTTP
status. Network failures, invalid response JSON and API rejections remain distinct;
raw causes, URLs, tokens, descriptions and request bodies are excluded. Polling
errors describe unconfirmed incoming reads, not fictitious outbound delivery.
Safe polling reads keep the existing retry behavior; writes and uncertain inputs
are not retried. Changes to these hub-only paths require a safe hub reload and
explicit reconnection, not interruption of the monitored working agents.

### Hub lifetime

One owner hub at a time is enforced by an OS-local named pipe. Opening in another
session does not take over or kill the owner. Close the original hub before
moving it; **Disconnect** stops traffic but the original hub retains ownership.
Closing just the panel leaves its bridge running while the hub runtime lives.
Reopening that panel does not require reconnecting an already connected bot.
The PC must remain awake and online. After restarting the hub/app, open the panel
and explicitly reconnect. Incoming Telegram history from before that connection
is discarded, and current questions are reconciled from the app.

The bridge scans app status every 15 seconds while connected and uses outbound
Telegram long polling. Safe reads retry after network failure/rate limits; uncertain
notifications and control actions are not resent automatically. Inspect uncertain
outcomes in the app; deleting/recreating a topic does not authorize an action retry.
Pending answered/uncertain control attempts still cannot be replayed.
The local panel polls only this bridge's in-memory state, without AI requests.

Idle notifications include the most recent public final assistant message or
agent task-completion summary captured by the personal extension in that selected
session. The listener uses native `assistant.message` (including the
`final_answer` phase), `session.task_complete` and `session.idle` events, never
transcript scraping or cross-session history guesses. Task summaries come from
the event's `summary` field, not tool arguments; forwarding one does not assert
that completion was accepted or successful. Its SDK
connection explicitly enables streaming and excludes subagent streams. When
text arrives incrementally, it collects `assistant.message_start` and
`assistant.message_delta` for the same message ID, but forwards nothing until
a qualifying terminal `assistant.message` confirms that message. Nonempty
terminal text takes precedence over streamed chunks. Missing start/terminal
events do not produce a partial reply, and duplicate chunks are ignored.
It ignores subagents, tool-call messages and reasoning. A captured public reply
survives internal model/tool iterations within the same uninterrupted run; an
empty final message or bookkeeping tool call does not erase it. New user messages,
connection/selection changes, idle and shutdown clear it, so an earlier exchange's
reply is never substituted. Unfinished streams also clear between model iterations.
After installing this feature or a listener fix, reload extensions in both the hub
and existing monitored sessions, or restart the app when safe. Reopening only the
hub does not update monitored-session listeners. No extra agents are launched, and messages from
before the listener was enabled are not replayed.

Only the latest reply is cached per selected session, scoped to its current opt-in
and bridge connection. Disconnecting, opting out or disabling idle notifications
clears the corresponding caches. A missing capture gets up to 30 seconds to arrive
on the normal polling loop; if none arrives, an explicit notice explains that the
reply was not captured. Confirmed silent turns stay quiet: current capture diagnostics
must show an observed empty public final message, its matching stream start, and no
received text chunks or task summary. The hub records `quiet` / `no-public-reply`
with zero sent parts, so repeated scans do not turn silence into an alert. A later
real reply is still forwarded normally. Unknown or missing diagnostics, incomplete
streams and canceled runs retain explicit notices; silence is not used to hide a
capture failure or substitute an older exchange's message.
Long replies are split into numbered Telegram
messages without truncation. Partial or uncertain sends are recorded for inspection
and never automatically retried. Replying to an idle notification in a session topic submits
a new instruction, not an answer to a question. The existing enabled idle-capture
path forwards Copilot's next public reply when the session becomes idle. A silent
turn still stays quiet, and missing captures remain explicit rather than inventing
a response.

Only the latest successful idle notification's message IDs are retained for
explicit reply routing outside session topics, including
all parts of a long reply, and they survive a normal hub restart or a later silent
turn that produces no visible notification. Outside a session topic, the bridge checks
the original bot, chat, topic and session-selection identities; partial/uncertain,
superseded or revoked deliveries cannot select a destination. Notifications sent before
this feature loaded have no message-ID receipts and are not guessed from their
text. In a session topic this is not a blocker: type a message normally or reply
to any non-question message, and the topic selects the session. Bridge/main-chat
messages without an exact retained reply target still need `/tell CODE ...`.
Nothing infers a question answer from an old notification or retries a previously
uncertain app command.

Prefix-free input routing loads in the hub, but the separate first-reply feature
above requires updated monitored-session listeners too. Any pending listener/storage
repair retains its own all-provider reload requirement. No old idle notification or
uncertain app message is resent to enable these features.

Idle notices show the session heading, the compact `* IDLE *` label, then the
reply itself without a "Last assistant message" introduction. Multi-part replies
keep a short `(part 1/2)` marker. One new idle event can produce one
notification (split into parts for a long reply); confirmed silent turns produce
none, and remaining idle does not cause repeated reminders. The runtime's
`session.idle` waits for attached shell commands and background agents to finish;
the separate `assistant.idle` processing-loop event is not used by this listener.
The hub also checks app-reported activity and reports a missing capture after its
timeout. Idle is not proof of task success, and detached or external processes are
not tracked. Plans/forms and
unsupported or oversized questions are alert-only when exposed in app status.
App-owned tool-permission alert coverage and remote-host prompts require live
qualification; there is no claim that every app dialog is visible. Underlying
app permissions are not bypassed. The bridge does not monitor native job queues
or diagnose stalled builds. A separate outside observer would be needed to detect
loss of the whole PC.

The app adapter uses the installed SDK's `session.rpc.tools.execute` with
`get_sessions_status`, `get_session`, `answer_session_input` and
`send_session_message`. It neither scrapes the desktop nor reads/writes the app
database. The question decoder accepts the app's native `kind: "question"` /
`prompt` format and the legacy `ask_user` / `question` format for both alerts and
answer revalidation. Plans, permissions and forms are never treated as ordinary
answerable questions. App-tool failure remains a visible integration failure, not permission
to bypass the native interface.

## Local data and maintenance

Source is in this personal extension folder, not a project repository.
`artifacts/state.json` retains selections, account identifiers and question/action
records, including reserved session codes. Legacy version-1 state is migrated
atomically to version 2 before the bridge starts.
The optional `topics` record holds bot/chat ownership, the Bridge and session
thread IDs, creation/rename/deletion attempt states and retired thread receipts.
Replacing or forgetting the bot
clears the local topic mappings without deleting Telegram history.
`artifacts/answer-receipts/` holds exact request-bound completion receipts, not a
transcript. Receipts are removed on session deselection, bot replacement, forgetting
the configuration or pruning their completed question records. `state.json`
retains each reconciled answer and its message-edit outcome; unresolved edits
are excluded from routine completed-question pruning.

`state.json` also holds per-phone-input capture intents: hashed incoming text,
exact source/session/account/connection/selection/topic bindings and app/delivery
outcomes. `artifacts/first-replies/` contains only each input's first captured
public reply and its native trigger/output identities, not tool arguments or a
transcript. Completed input/capture records are pruned to the latest 200;
disconnect/reselection removes ordinary completed or pending captures. Uncertain
app actions and attempted/uncertain delivery evidence are retained, excluded from
automatic replay, and shown in unresolved status. Explicitly replacing/forgetting
the bot clears these local records under the existing reset policy.

`artifacts/idle-replies/` holds one current reply per selected session. A normal
reply retains its message ID; a task summary retains its actual completion-event
ID instead. Each record also holds bounded, text-free capture diagnostics:
listener format version, event counts, and the last terminal/completion event's
identity, text lengths and capture disposition. These distinguish empty live
messages, missing streams and ignored message types without storing another
transcript. Diagnostics are local only and are cleared with the reply cache.
`artifacts/idle-replies/` holds at most the latest captured idle reply per selected
session; it is not a conversation archive.
The corresponding `state.json` signal retains the latest delivery attempt and a
separate confirmed `idleReply` receipt with Telegram message IDs and reply-target
binding, not another copy of the reply text. The confirmed receipt changes only
after a complete successful send has been saved.
`artifacts/bot.dpapi` stores the token encrypted for the current Windows
user. Credentials are passed to Windows encryption through stdin, never process
arguments, and are never returned by the canvas's agent-readable status action.
**Do not publish or share the artifacts folder.**

The HTTP panel binds only to `127.0.0.1` on a random port, checks Host/Origin,
requires a random capability header for data/actions, and uses no CORS. Its
capability starts in the URL fragment, is removed from browser history, and is
not written to disk. Plain question text is rendered as text, not HTML.
Telegram errors deliberately exclude tokens, API URLs and upstream descriptions.

### Windows file-access coordination

On the verified Windows/Node runtime, replacing an existing file can fail with
`EPERM` while a normal reader holds it open, even with delete-sharing enabled.
The bridge's per-session listeners and hub therefore coordinate all reads,
atomic replacements and removals of state, idle/first-reply caches and answer receipts
through one Windows named-pipe lock per normalized file path. Credential storage
uses the same file helper without changing DPAPI encryption. The pipe carries
no file contents, is separate from hub ownership and is released by the OS if
its owner exits; there is no persistent lock file to delete or take over.

File operations wait for exclusive access for up to five seconds. A timeout
fails explicitly without running the blocked operation. Waiting callers connect
to the current owner's pipe and wake when it closes, instead of competing on
10-25 millisecond timers that can miss brief release windows. Closure is only a
wakeup: every caller must still acquire its own exclusive pipe before touching
the file. The deadline covers the entire acquisition, is not restarted by a
wakeup, and does not permit a timed-out operation to run later. Owner release
closes waiting connections; timeout disconnects its waiter. Owner process/worker
exit releases the same OS resource without stale files or delegated lock ownership.
No pipe payload, native addon, external daemon or new dependency is required.
This is not a strict FIFO scheduling guarantee.

The existing serialized
hub remains responsible for write ordering and action receipts. Saves still
replace a complete temporary file atomically: no in-place truncation,
delete-then-rename workaround or automatic retry of a failed save or Telegram
action. An external program that does not use this coordination can still block
replacement; that error remains visible, and uncertain actions are not cleared.

**This repair must be loaded in every Telegram extension provider, not just
the hub or selected sessions.** Unselected providers also read state to check
their eligibility. Restart Copilot when its jobs can safely be interrupted, then
open the hub and click **Connect saved bot**. Reopening the panel alone does not
reload providers. Existing uncertain receipts remain pending after deployment.

Use **Forget token, phone and session selections** to remove the saved credential
and records. Revoke the bot token in BotFather if compromise is suspected.
Uninstalling the extension without removing artifacts leaves its local records.

Validation (Node 22+, Windows), from this extension directory:

```powershell
$tests = @(Get-ChildItem -File -Filter '*.test.mjs' | ForEach-Object FullName)
node --test --test-concurrency=1 @tests
```

Tests use synthetic app/Telegram responses and isolated temporary state, including
the Windows credential helper with a fake secret. They do not need a real bot,
real user credentials, or a live Copilot session. The runtime entrypoint is loaded
by Copilot, not by running `node extension.mjs`. The repository's Windows CI
checks JavaScript syntax and runs these tests.

The release-notified locking regression covers
[LarsLiden/skills#11](https://github.com/LarsLiden/skills/issues/11). Keep the
eight-reader/300-replacement stress case, explicit acquisition-timeout test,
owner-exit checks and external-lock failure checks. Test reader rejections are
handled immediately and still fail the test, rather than becoming late unhandled
promise rejections. Neither a passing routing test nor issue tracking substitutes
for storage verification.

Live acceptance is separate: extension discovery, app RPC access, a dedicated
Telegram bot paired by the user, locked-phone delivery and an actual question
reply must all be checked before calling the integration fully qualified.

Local tests are not evidence of a successful phone round trip. Check the first
public response, later idle result, original-question answer edit and exact topic
destination on the new installation. Listener or file-access changes require
reloaded hub/monitored-session providers. Keep uncertain actions and failed
checks unresolved rather than treating a successful reload as delivery evidence.
