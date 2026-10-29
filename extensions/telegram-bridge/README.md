# Copilot Telegram bridge

Receive Copilot questions and replies on your phone, and answer or send new
instructions through Telegram. Each selected Copilot session can have its own
private Telegram topic.

This is a **GitHub Copilot desktop canvas extension**, not an Agent Skill.
Install it separately from this repository's `skills/` directory; **do not use
`gh skill install` for it**.

## Requirements

- **Windows**, with Windows PowerShell available for DPAPI-protected credentials.
  macOS and Linux credential storage are not implemented.
- A GitHub Copilot desktop build that supports user canvas extensions and the
  app session tools. A standalone terminal agent is not a substitute for the
  desktop app's session connection.
- Telegram on your phone and a dedicated Telegram bot. Creating the bot is free;
  the bridge itself needs no paid messaging service, public server or extra AI
  agent. Normal Copilot usage still applies to the work you ask agents to do.
- Keep the computer awake, online, and Copilot running. Notifications cannot
  arrive from a computer that is asleep, shut down or disconnected.

The desktop app supplies `@github/copilot-sdk`. **Do not install a separate SDK,
run `npm install`, or launch `extension.mjs` directly with Node.** Node.js 22+
is needed separately only if you want to run the development tests.

## 1. Install on the computer running Copilot

### Recommended: install from GitHub in Copilot

Paste this into a Copilot desktop conversation:

```text
Install this Copilot canvas extension at user scope:
https://github.com/LarsLiden/skills/tree/main/extensions/telegram-bridge
```

The app's `install_extension` operation accepts that repository-folder URL.
**User scope** makes it available across projects on that computer. Keep the
extension name `telegram-bridge`.

The normal installation directory is:

```text
%USERPROFILE%\.copilot\extensions\telegram-bridge
```

If `COPILOT_HOME` is configured, the directory is
`%COPILOT_HOME%\extensions\telegram-bridge` instead.

The installer reloads extensions for its session. Existing sessions that were
already running may still have old or missing listeners. Once active jobs can
safely be interrupted, restart the entire Copilot app, then reopen those sessions
and the bridge. Starting a new session after installation also loads its listener.

### Manual installation if the app's installer is unavailable

Clone this repository or download and extract its ZIP. Copy **only the files
directly inside** `extensions\telegram-bridge` into the user installation
directory above, then restart Copilot when safe.

For a **fresh installation**, this PowerShell example uses Git and refuses to
overwrite an existing installation:

```powershell
git clone --depth 1 https://github.com/LarsLiden/skills.git
if ($LASTEXITCODE -ne 0) { throw "Clone failed." }

$source = Join-Path (Resolve-Path .\skills).Path 'extensions\telegram-bridge'
$homeDirectory = if ($env:COPILOT_HOME) {
    $env:COPILOT_HOME
} else {
    Join-Path $env:USERPROFILE '.copilot'
}
$destination = Join-Path $homeDirectory 'extensions\telegram-bridge'
if (Test-Path -LiteralPath $destination) {
    throw "An installation already exists. Follow the update instructions instead."
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath $source -File -Force |
    Copy-Item -Destination $destination -ErrorAction Stop
```

**Never copy an installed bridge's `artifacts` directory to another computer or
commit it to Git.** It contains credentials, account identifiers, pairing,
session/topic mappings, questions and captured replies. These belong to the
original installation, not to the shared extension.

## 2. Open one bridge hub

Create a dedicated chat in Copilot, name it something like **Telegram bridge**,
and ask:

```text
Open the Telegram bridge setup panel in this chat and check the app connection.
Leave connecting the bot and selecting sessions to me.
```

The panel is the `telegram-bridge` canvas. Its read-only `check_app_connection`
action should report that it can see Copilot sessions. If that fails, resolve the
app connection before relying on phone notifications.

Keep **one hub per computer**. The hub cannot monitor itself. Other opted-in
sessions supply their own reply listeners; they do not each need a setup panel.
Closing/reopening the panel does not stop the bot. Use the panel's disconnect
control, or close the hub session, to stop it.

The hub is **relay-only, not a project coordinator**. After its panel successfully
acquires bridge ownership, the extension records that exact hub session ID and
injects role guidance on session start/resume, each submitted prompt and after
tools. This persists across provider reloads and does not apply to monitored
coding sessions or their subagents.

Explicitly addressed payloads keep their exact text and sender/destination
attribution under the existing routing checks. Incoming cross-session reports or
requests for approvals, provenance checks, scope changes or coordinator action
do not change the hub's role. The hub should not invent approvals, investigate
authority, negotiate scope, assign work, summarize unrelated progress or send
self-authored coordination replies. Routine reports without a requested relay
remain unanswered. Explicit user requests to configure, maintain or fix the
bridge itself remain supported.

This is **instruction-level mitigation**, not a guarantee of model behavior or
a tool-permission sandbox. Host safety and routing safeguards remain in force;
the hooks do not rewrite messages, automatically forward reports or grant
approvals. To activate an update to this guidance, install `extension.mjs` and
`hub-role.mjs`, safely reload only the hub provider, reopen its panel and use
**Connect saved bot**. Merely reopening a panel running old code is insufficient.
Monitored-session listeners do not need reloading for this hub-only change.

## 3. Create a bot and pair your phone

1. In Telegram, open the official **@BotFather** account and send `/newbot`.
   Choose a name and bot username that identify the computer, such as
   `Copilot Desktop` or `Copilot Laptop`.
2. Copy BotFather's token into the **password field in the local setup panel**.
   Click **Save token and connect**. Never paste a real token into an agent
   conversation, terminal command, source file or GitHub.
3. In the panel, generate the pairing link. Open it in Telegram on your phone
   and press **Start**.
4. Return to the local panel and confirm the displayed Telegram account. The
   bridge accepts only the paired private account, not groups or other senders.
5. Refresh the session list and explicitly select the Copilot sessions you
   want to monitor. Leave sensitive sessions unselected.

The token, pairing and selections are saved locally. On later starts, use
**Connect saved bot**; you do not need to create a new bot or pair again.
**Replace saved bot** is for intentionally changing bots, not reconnecting.

## 4. Enable session topics

Use your **existing bridge bot**. No new bot, token or pairing is needed, and
existing messages stay where they are.

1. In Telegram, open the official [**@BotFather**](https://t.me/BotFather)
   conversation, **not your bridge bot's conversation**.
2. Tap **BotFather's name at the top** to open its profile, then tap **Open App**
   or **Launch App** to open BotFather's management mini app. This is **not
   Configure Mini App** in the chat's Bot Settings menu; that configures a mini
   app for your own bot.
3. In the management app, select your **existing bridge bot**. Find its
   topic/thread settings and enable **topics in private chats**. Labels vary by
   Telegram version; look for **Threads Settings** or **Threaded Mode**, not
   necessarily those exact labels.
4. Return to the connected, paired bridge panel and click **Enable session topics**.
   The bridge checks the bot's reported support before using them.
5. On your phone, return to Telegram's **chat list** and reopen your **bridge bot's
   conversation**. You should see a **Bridge** topic and a topic named after each
   selected Copilot session. If the old mixed view remains, reopen it again.
   Do not recreate topics just to refresh that view.

**Alternative chat-menu route:** send `/mybots` to **@BotFather**, select your
existing bridge bot, then look under **Bot Settings > Threads Settings > Threaded
Mode**. Turn it on if present. This route is not available in every version. If
**Threads Settings** is missing, use BotFather's profile and **Open App** or
**Launch App** instead, not **Configure Mini App**, then return to the bridge panel.

[Telegram's official guide](https://core.telegram.org/bots/features#topics-in-private-chats)
confirms that private-chat topics must be enabled via BotFather, but does not
specify exact menu labels. The profile-to-management-app route above was confirmed
in live setup; the chat-menu labels are also shown in this
[illustrated third-party guide](https://gajae-code.com/docs/telegram-onboarding.html#2-enable-threaded-mode-in-botfather).
Neither source guarantees the same labels in every Telegram version.

**Deselection permanently deletes that session's Telegram topic and its message
history.** The bridge also cleans up topics for sessions the app explicitly
confirms are archived/deleted. Idle sessions and temporarily unavailable sessions
are retained; a failed lookup is not proof of deletion. The Bridge topic remains.

## 5. Use it from your phone

| Action | What to do |
| --- | --- |
| Answer a multiple-choice question | Read the full numbered choices in the question, then tap the matching **Choose 1**, **Choose 2**, etc. button, or use Telegram **Reply** on that exact question. |
| Answer a free-text question | Select that exact question in Telegram and choose **Reply**, then type and send your answer. |
| Send a new instruction | Type normally inside the session's topic. **No `/tell` prefix is needed.** |
| Reply to an idle/result message | Use Telegram Reply inside its session topic; only your new text is sent. |
| Send from Bridge, without topics, or when Telegram omits the topic | Type normally, then tap the intended session's button. Nothing is sent until you choose. |
| Address a session explicitly | Use `/tell 042 Your instruction`, replacing `042` with the exact three-digit code from `/status`. |
| Check sessions | Send `/status`. Inside a session topic it shows that session; in Bridge it lists your selections. |
| Show help | Send `/help`. |

Session routing depends on the topic information Telegram includes, not the
topic name visible on your phone. When a fresh ordinary message has no destination,
the bot replies to it with **session buttons**. Tap the intended session to send
that exact message, or **Cancel this message** to discard it without canceling any
agent work. Each message has its own choices; choosing once never establishes a
default for later messages. Buttons include stable three-digit codes to distinguish
duplicate names, with Previous/Next pages when needed.

The bridge holds the unsent text **only in the connected hub's memory**, not on
disk. It discards it on cancellation, use, disconnect, restart, or removal of its
source receipt from the existing 200-completed-input history. Old buttons cannot
restore or replay it. If a chooser expires, send a fresh message; previously
rejected messages are not recovered automatically. This handles missing topic
metadata without guessing its cause or the session you intended.

Messages with valid session topics still go directly. Replying to a non-question
bot message in that topic or using `/tell 042 ...` also supplies an explicit
destination. A stale or unmatched reply is not converted into a new message.
You can compare routing paths safely with `/status`, which reports bridge status
without sending an instruction to an agent.

After a phone message or answer:

- The bridge acknowledges app acceptance. That acknowledgment is **not** an
  agent response or proof of task completion.
- **`* REPLY *`** contains the first captured complete public agent reply,
  including a progress preamble when available, without waiting for the job to
  finish. Partial streaming tokens, reasoning and tool arguments are not sent.
- **`* FINAL *`** contains the final captured result promptly at native session
  idle, independently of the inactivity setting. If the same native message or
  task-summary event was already forwarded as the first reply, it is not sent again.
- **Inactive for 15 minutes** is a separate, optional notice, not another copy
  of the result. It requires 15 continuous minutes of app-reported idle with no
  newly observed messages, tool activity or job-status events. Activity resets the
  timer, with only one notice per quiet period. Questions never wait for it.

Unknown/unavailable status, pending questions/plans/permissions/forms, app scan
failures, a stale/missing listener or an observation gap stop the quiet timer.
Reconnect, reselection and provider/app restart require a new observation baseline;
time while disconnected is not credited. The hub scans normally every 15 seconds,
so a qualifying notice may arrive later than the exact 15-minute boundary, never
earlier. Listener heartbeats are local liveness observations, not proof that every
SDK event or hidden job was visible. Repeated unchanged scans do not reset time.
The notice does not mean the task succeeded or that detached/external work stopped.

Plans, permissions and structured forms stay in Copilot. Ordinary text does not
bypass a pending decision, and stale question replies are rejected. An uncertain
app action or Telegram send is recorded rather than automatically replayed.
Before sending an answer, check that the reply preview identifies the current
question, not an earlier result or topic message. Typing a regular message does
not answer a pending question. Once answered, the original question is updated
to show the answer.

## Multiple computers

Use **one different bot per simultaneously active computer**. Install the same
code independently on each computer, pair each bot with your same Telegram
account, and select that computer's sessions. You will have separate bot
conversations on your phone, each with its own topics.

Do not reuse one bot token in two active installations: their receivers compete
for the same Telegram updates. Do not synchronize the `artifacts` directories.
Windows-encrypted credentials and session mappings are local, not portable setup.

## Check a new installation

Use a harmless test session and a fresh Telegram message:

1. Confirm the app connection check succeeds and the desired sessions are
   selected. After connecting, confirm a successful sync and no current error.
2. Ask the test agent to offer a simple question. Confirm the phone notification
   appears in that session's topic, then answer the exact question.
3. Confirm the agent receives your answer, its first public response arrives,
   and the original question shows the accepted answer.
4. Send a new harmless instruction directly in the topic. Confirm the agent
   receives it, the first response arrives before a longer task finishes, and
   a different final result arrives promptly at native idle even with inactivity
   notices disabled. An identical first/final native reply should appear only once.
5. Type a separate harmless instruction in Bridge. Confirm it waits without
   reaching Copilot, then tap the test session and confirm that exact instruction
   and its response arrive once. Cancel another unsent message and confirm it
   does not reach the agent.
6. Confirm locked-phone notifications are permitted in Telegram and by your
   phone's notification/Focus settings.
7. With inactivity notices enabled, leave the session idle and quiet for 15 minutes.
   Confirm one **Inactive for 15 minutes** notice, no repeated reminders, and a
   full fresh quiet period after new activity. Confirm a pending question still
   alerts promptly instead of waiting for that timer.

A successful local test suite, an open panel, or `connected: true` alone does
not verify the entire phone round trip. If a message's outcome is uncertain,
inspect Copilot before resending it.

### Check a missing incoming message

The panel's **Incoming Telegram messages** section separates the last successful
Telegram poll from the last app scan. A recent app scan does not prove that
Telegram messages are being received. Polling errors show the operation, stage,
time and a limited network error code, without exposing the bot token or request
body. Recovery clears the current polling error only after a successful poll;
the last failure time stays visible for this hub runtime.

The most recent 20 inbound receipts show the Telegram message/update/topic IDs,
receipt time, selected session and outcome. **Not sent** means no app instruction
was dispatched. **Accepted by Copilot** remains accepted even if a later phone
confirmation fails. **Uncertain** or **Interrupted** requires inspection, not
automatic resending. Receipts store metadata and a content hash, not incoming
message text. They start with this version and cannot reconstruct older missing
messages. Telegram check marks or a later idle notification are not app receipts.
Destination choices have separate **Awaiting destination**, **Chosen**,
**Canceled**, **Expired** and uncertain-notification labels. Chosen is not app
acceptance: inspect the linked selection-update receipt for the actual app
outcome. Selection callbacks refer back to the original message's update ID.
Pending text is never included in the panel or read-only status.

If receipt storage fails, incoming processing pauses before acknowledging further
updates. Preserve local state and inspect the failure before restarting; do not
delete receipts or reconnect as an automatic recovery. Restart/reconnect still
discards pre-connection Telegram updates rather than replaying old instructions.

## Updating

Updates are **not automatically synchronized** between computers.

When jobs can safely be interrupted, disconnect the bot and close Copilot.
Download the new source from the same repository folder, then replace only the
top-level extension source/test/documentation files in your installation.
**Preserve the existing `artifacts` directory on that same computer.** Do not
replace the entire installation with a clean directory or synchronize artifacts
from another machine.

Restart Copilot and reopen the hub and monitored sessions. Click **Connect saved
bot**. Reopening only the hub panel does not reload listeners in other sessions.
Repeat the harmless round-trip check after listener changes. If using the app's
installer to update, first confirm its overwrite behavior preserves local
artifacts; the manual source-only update above makes that boundary explicit.

Destination buttons and question-instruction wording run only in the hub.
If updating only those paths, a safe hub-provider reload and explicit saved-bot
reconnection suffice; monitored sessions' existing listeners need not restart.
Reopening the canvas alone does not reload provider code.

The 15-minute inactivity behavior changes both the hub and per-session listeners.
Install all top-level files, including `activity.mjs`, then safely reload the hub
and each monitored session (or restart Copilot when jobs can be interrupted) and
explicitly reconnect the saved bot in the **existing hub**. A hub-only update is
insufficient. Publishing a working branch does not update `main` or your installed
extension; choose that branch/commit explicitly when downloading this change.
Do not copy or reset artifacts, replay old phone messages, or create a new hub.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Canvas not found | Confirm `extension.mjs` is directly in the user extension folder; restart Copilot. A project extension with the same name can shadow the user extension. |
| Another hub owns the bridge | Return to that existing hub or close it before opening another. Do not delete state/locks or run competing receivers. |
| Connected but no sessions or no sync | Run the read-only app connection check. Check incoming polling separately; app scans do not prove receipt of Telegram messages. App permission, RPC or response-format errors need diagnosis; zero loaded rows does not mean saved selections were removed. |
| An incoming message never reached Copilot | Inspect its recent inbound receipt and polling health. A failed app preflight is recorded as not sent; no unknown action is automatically replayed. Old messages without receipts remain unverified. |
| Messages arrive but the first/final response does not | Ensure the monitored session, not only the hub, loaded the latest extension. Check its capture warnings; missing or ambiguous input attribution is not guessed. |
| Bot conflict or disconnected receiver | Ensure no other computer or application is using that bot token. Use separate bots. |
| State-file `EPERM` or access timeout | Load release-notified file-access coordination in every provider by restarting Copilot when safe, not just reopening the hub. Its five-second limit is unchanged. External file locks can still fail; preserve state and investigate instead of deleting it. |
| Uncertain action, notification or question update | Inspect the original Copilot/Telegram result. Do not clear receipts, recreate topics or resend automatically. |
| No alert while phone is locked | Check Telegram notification permissions, muted chats/topics, Focus mode, and whether the computer is awake and online. |

## Privacy and limitations

Bot conversations are **not end-to-end encrypted**. Opt-in shares session names,
questions, choices, answers and captured public replies with Telegram. The local
panel binds to loopback only. Tokens are encrypted for the current Windows user.
Private local state is excluded from this repository.

The bridge does not provide blanket approvals, remote desktop control, historical
transcript replay or guaranteed coverage of every Copilot dialog. It does not
diagnose stalled native jobs, and idle is not proof of success. Remote-host
sessions and different desktop builds need their own live qualification.
Inactivity observes app activity status and delivered SDK message/tool/subagent/
background-change events only; it is not a native job-queue monitor. SDK background
change events expose no job-state payload in the verified declarations. Missing
events, hidden jobs and activity entirely between app polls without a delivered
listener event cannot be reconstructed. Listener liveness is checked against a
45-second maximum observation gap, not an instantaneous disconnect signal.

See [DEVELOPMENT.md](DEVELOPMENT.md) for the implementation contracts, storage,
privacy boundaries and test instructions.
