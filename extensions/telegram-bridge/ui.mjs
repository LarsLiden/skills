const key = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const $ = id => document.getElementById(id);
let busy = false, state, replacingBot = false;

async function request(path, input) {
    const response = await fetch(path, {
        method: input ? "POST" : "GET",
        headers: { "X-Bridge-Key": key, ...(input ? { "Content-Type": "application/json" } : {}) },
        ...(input ? { body: JSON.stringify(input) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Local bridge request failed.");
    return result;
}

function notice(message, error = false) {
    $("notice").textContent = message;
    $("notice").classList.toggle("error", error);
}
function render(value) {
    if (state && state.configured !== value.configured) {
        replacingBot = false;
        $("token").value = "";
    }
    state = value;
    const selected = value.sessions.filter(item => item.selected).length;
    let message;
    if (!value.configured) message = "No bot saved. Complete the one-time setup below.";
    else if (!value.connected) message = value.started
        ? "Connection stopped. Disconnect, then reconnect your saved bot. No phone commands or alerts are active."
        : "Your bot is saved but disconnected. Use Connect saved bot to resume. No phone commands or alerts are active.";
    else if (!value.peer) message = "Bot connected. Pair your phone to enable commands and alerts.";
    else if (!value.enabled) message = "Bot connected, but phone commands and monitoring are paused. Disconnect and reconnect to resume.";
    else message = selected
        ? `Connected to your phone. Monitoring ${selected} selected session(s).`
        : "Connected to your phone. No available sessions are selected; choose sessions below.";
    notice(value.error ?? message, Boolean(value.error));
    $("bot-heading").textContent = !value.configured ? "1. Set up a bot"
        : value.connected ? "1. Bot connected" : value.started ? "1. Connection stopped" : "1. Reconnect your saved bot";
    $("bot-status").textContent = value.configured
        ? `${value.bot ? `Saved bot: @${value.bot.username}.` : "A bot token is saved."} Token stays local and is never shown again.`
        : "No bot configured.";
    $("connection-help").textContent = !value.configured ? "Create a dedicated bot once. Its token will be saved securely on this computer."
        : value.connected ? "Your saved bot is connected. You do not need to create another bot or enter its token again."
        : value.started ? "Disconnect the stopped connection before reconnecting. Your saved bot, phone pairing and selections are retained."
        : "Reconnect using the saved token. Your phone pairing and session selections are retained; no new bot or token is needed.";
    $("bot-setup").hidden = value.configured && !replacingBot;
    $("new-bot-help").hidden = value.configured;
    $("replace-bot-help").hidden = !value.configured;
    $("configure").textContent = value.configured ? "Replace bot and connect" : "Save token and connect";
    $("cancel-bot").hidden = !value.configured;
    $("change-bot").hidden = !value.configured || replacingBot;
    $("connect").hidden = !value.configured || value.connected || replacingBot;
    $("connect").disabled = !value.configured || value.connected || value.started;
    $("stop").hidden = !value.started;
    $("stop").disabled = !value.started;
    $("phone-heading").textContent = value.peer ? "2. Phone paired" : "2. Pair your private chat";
    $("pair-help").textContent = value.peer ? "Your phone pairing is saved. Reconnecting the bot does not require pairing again."
        : value.connected ? "Generate a one-use link, open it on your phone, press Start, then confirm the account here."
        : "Connect your bot first, then generate a one-use link to pair your phone.";
    $("pair").hidden = Boolean(value.peer);
    $("pair").disabled = !value.connected || Boolean(value.peer);
    $("peer").textContent = value.peer ? `Paired with ${value.peer.name} (account ${value.peer.id}).` : "No phone paired.";
    $("pair-link").replaceChildren();
    if (value.pairing?.link) {
        const link = document.createElement("a");
        link.href = value.pairing.link; link.target = "_blank"; link.rel = "noreferrer";
        link.textContent = value.pairing.link;
        $("pair-link").append(link, document.createElement("br"),
            document.createTextNode("Expires " + new Date(value.pairing.expires).toLocaleTimeString()));
    }
    const candidate = value.pairing?.candidate;
    $("candidate").textContent = candidate ? `Confirm the account shown on your phone: ${candidate.name} (${candidate.id}).` : "";
    $("confirm").hidden = !candidate;
    $("refresh").disabled = !value.connected;
    $("idle").disabled = !value.connected;
    $("session-help").hidden = value.connected;
    $("session-help").textContent = value.configured
        ? "Reconnect your saved bot to manage sessions. Your saved selections are retained."
        : "Connect your bot before choosing sessions.";
    $("idle").checked = value.notifyIdle;
    const list = $("sessions");
    list.replaceChildren();
    const choices = [...value.sessions, ...value.selectedMissing.map(item => ({ ...item, selected: true, unavailable: true }))];
    for (const item of choices) {
        const label = document.createElement("label"); label.className = "check session";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = item.selected;
        checkbox.disabled = !value.connected;
        checkbox.addEventListener("change", () => action({ action: "optIn", sessionId: item.id, enabled: checkbox.checked }));
        const text = document.createElement("span"); text.textContent = item.name;
        if (item.unavailable) {
            const marker = document.createElement("span"); marker.className = "unavailable-marker";
            marker.textContent = " * Unavailable";
            text.append(marker);
        }
        const details = document.createElement("small");
        details.textContent = (item.unavailable ? "Not currently visible in Copilot" : `${item.project} | ${item.activity}`)
            + (item.alias ? ` | alias ${item.alias}` : "");
        text.append(details); label.append(checkbox, text); list.append(label);
    }
    if (!choices.length) list.textContent = value.connected
        ? "Refresh to list available app sessions. The hub itself is excluded."
        : "Session choices will be available after connecting.";
    $("missing").textContent = value.selectedMissing.length
        ? `${value.selectedMissing.length} selected session(s) are currently unavailable, marked * Unavailable above.` : "";
    $("health").textContent = (value.lastSync ? `Last successful app scan: ${new Date(value.lastSync).toLocaleString()}.` : "App status has not been scanned yet.")
        + (value.connected ? " App scanning interval: 15 seconds." : " Automatic app scanning is stopped while disconnected.");
    const time = instant => instant ? new Date(instant).toLocaleString(undefined, { timeZoneName: "short" }) : "unknown time";
    const poll = value.health?.poll;
    $("incoming-health").textContent = (value.inbound?.paused ? "Incoming receiving is paused after a storage failure. " : "")
        + (poll?.lastSuccess ? `Last successful Telegram poll: ${time(poll.lastSuccess)}. ` : "Incoming Telegram polling is not yet confirmed. ")
        + (!value.connected ? "Polling is stopped. " : "")
        + (poll?.error ? `Current polling error: ${poll.error} ` : "")
        + (poll?.lastFailure ? `Last polling failure: ${time(poll.lastFailure)}`
            + (poll.recoveredAt && !poll.error ? `; recovered ${time(poll.recoveredAt)}. ` : ". ") : "")
        + `${value.inbound?.pendingDestinations ?? 0} message(s) awaiting a destination choice; not sent to Copilot. `
        + "An app scan or successful poll is not proof that a particular message was delivered.";
    const incoming = $("incoming");
    incoming.replaceChildren();
    const states = { received: "Received; not yet dispatched", attempting: "App dispatch in progress",
        accepted: "Accepted by Copilot", uncertain: "App outcome uncertain", "not-sent": "Not sent",
        handled: "Bridge command handled", interrupted: "Interrupted; not replayed" };
    for (const receipt of value.inbound?.recent ?? []) {
        const item = document.createElement("p");
        const choice = receipt.destinationChoice;
        const choiceStates = { notifying: "Sending destination chooser; not sent to Copilot",
            pending: "Awaiting destination; not sent to Copilot", canceled: "Canceled; not sent to Copilot",
            expired: "Destination choice expired; not sent to Copilot",
            uncertain: "Chooser delivery uncertain; not sent to Copilot",
            chosen: `Destination chosen; see selection update ${choice?.callbackUpdateId}` };
        const name = choices.find(session => session.id === receipt.sessionId)?.name
            ?? receipt.sessionId ?? "No session destination";
        item.textContent = `Message ${receipt.messageId ?? "unknown"} (update ${receipt.updateId}, topic ${receipt.threadId ?? "main"}): `
            + `${choice ? choiceStates[choice.state] ?? "Unknown destination-choice outcome"
                : states[receipt.state] ?? "Unknown outcome"} - ${name}. Received ${time(receipt.receivedAt)}.`
            + (receipt.sourceUpdateId !== undefined ? ` Original update ${receipt.sourceUpdateId}.` : "")
            + (choice?.reason ? ` ${choice.reason}` : "")
            + (receipt.reason ? ` ${receipt.reason}` : "")
            + (receipt.failure ? ` Failure during ${receipt.failure.stage}; inspect the bridge log before resending.` : "");
        incoming.append(item);
    }
    if (!value.inbound?.recent?.length) incoming.textContent = "No inbound receipts recorded by this version yet.";
    $("unresolved").textContent = value.unresolved.length ? `${value.unresolved.length} notification/action outcome(s) need inspection in the app. No uncertain action is automatically replayed.` : "";
    const topics = value.topics;
    $("enable-topics").disabled = !value.connected || !value.peer || !value.enabled;
    $("enable-topics").textContent = topics?.enabled ? "Sync session topics" : "Enable session topics";
    $("topics-status").textContent = topics?.enabled
        ? `${topics.ready} session topic(s) available, plus Bridge. New session messages use their topics.`
            + (topics.issues.length ? `\n${topics.issues.join("\n")}` : "")
        : "Session topics are off. Connect and pair first, then enable them explicitly.";
    $("topics-status").classList.toggle("warning", Boolean(topics?.issues.length));
}
async function action(input) {
    if (busy) return;
    busy = true;
    try {
        notice("Working...");
        const value = await request("/api/action", input);
        if (input.action === "configure") replacingBot = false;
        render(value);
    } catch (error) { notice(error.message, true); }
    finally { busy = false; }
}
$("configure").addEventListener("click", () => {
    const token = $("token").value; $("token").value = "";
    if (state?.configured && !confirm("Changing the bot clears its phone pairing and session selections. Continue?")) return;
    void action({ action: "configure", token });
});
$("change-bot").addEventListener("click", () => {
    replacingBot = true;
    render(state);
    $("token").focus();
});
$("cancel-bot").addEventListener("click", () => {
    replacingBot = false;
    $("token").value = "";
    render(state);
    $("change-bot").focus();
});
for (const [id, name] of [["connect", "connect"], ["stop", "stop"], ["pair", "pair"], ["refresh", "refresh"]]) {
    $(id).addEventListener("click", () => { void action({ action: name }); });
}
$("confirm").addEventListener("click", () => { void action({ action: "confirm", userId: state.pairing?.candidate?.id }); });
$("idle").addEventListener("change", () => { void action({ action: "idle", enabled: $("idle").checked }); });
$("enable-topics").addEventListener("click", () => { void action({ action: "topics" }); });
$("forget").addEventListener("click", () => {
    if (confirm("Disconnect and remove the local bot token, phone pairing and all selections?")) void action({ action: "forget" });
});
async function refresh() {
    if (!busy) {
        try { render(await request("/api/status")); }
        catch (error) { notice(error.message, true); }
    }
}
await refresh();
setInterval(refresh, 3000);
