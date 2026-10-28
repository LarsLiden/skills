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

1. In BotFather's settings for this bot, enable **topics in private chats**.
   The bridge checks the bot's reported support before using them.
2. In the connected, paired setup panel, click **Enable session topics**.
3. Open the bot conversation on your phone. You should see a **Bridge** topic
   and a topic named after each selected Copilot session.

If Telegram on Android still shows a mixed conversation, return to Telegram's
chat list and reopen the bot. Do not recreate topics just to refresh that view.

**Deselection permanently deletes that session's Telegram topic and its message
history.** The bridge also cleans up topics for sessions the app explicitly
confirms are archived/deleted. Idle sessions and temporarily unavailable sessions
are retained; a failed lookup is not proof of deletion. The Bridge topic remains.

## 5. Use it from your phone

| Action | What to do |
| --- | --- |
| Answer a multiple-choice question | Tap its choice button, or use Telegram **Reply** on that exact question. |
| Answer a free-text question | Select that exact question in Telegram and choose **Reply**, then type and send your answer. |
| Send a new instruction | Type normally inside the session's topic. **No `/tell` prefix is needed.** |
| Reply to an idle/result message | Use Telegram Reply inside its session topic; only your new text is sent. |
| Send from Bridge or without topics | Use `/tell 042 Your instruction`, replacing `042` with the exact three-digit code from `/status`. |
| Check sessions | Send `/status`. Inside a session topic it shows that session; in Bridge it lists your selections. |
| Show help | Send `/help`. |

After a phone message or answer:

- The bridge acknowledges app acceptance. That acknowledgment is **not** an
  agent response or proof of task completion.
- **`* REPLY *`** contains the first captured complete public agent reply,
  including a progress preamble when available, without waiting for the job to
  finish. Partial streaming tokens, reasoning and tool arguments are not sent.
- **`* IDLE *`** contains the final captured result when the session becomes idle,
  if idle notices are enabled. If its only reply was already final, that text can
  appear again with the separate idle transition.

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
   the final result arrives at idle.
5. Confirm locked-phone notifications are permitted in Telegram and by your
   phone's notification/Focus settings.

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

See [DEVELOPMENT.md](DEVELOPMENT.md) for the implementation contracts, storage,
privacy boundaries and test instructions.
