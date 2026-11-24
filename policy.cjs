Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
// policy.ts
function ordinary(event) {
	return !(event._hermes_reaction || event._hermes_force_process || event.bot_id || typeof event.client_msg_id === "string" && event.client_msg_id.startsWith("de1e6a7e-"));
}
function answersForSure(event, user, bot) {
	if (event._slack_changed_event_ts || event.user !== user || !ordinary(event)) return false;
	const text = String(event.text || "");
	const command = bot ? text.replaceAll("<@" + bot + ">", "") : text;
	return !/^[!/]/.test(command.trimStart()) && [...text.matchAll(/<@([UW][A-Z0-9]+)/g)].every((match) => match[1] === bot);
}
function turnRoute(event, quickDelegate, isBot, replyExpected) {
	if (quickDelegate && !isBot && replyExpected && !event._slack_changed_event_ts) return "delegate";
	if (typeof event.client_msg_id === "string" && /^de1e6a7e-(b075|c0de)-/.test(event.client_msg_id)) return "report";
	return "standard";
}
function where(event, channel, name) {
	const kind = event.channel_type || (channel.startsWith("D") ? "im" : "");
	let place = "a channel";
	if (kind === "im") place = "a DM with Hermes";
	else if (kind === "mpim") place = "a group DM";
	else if (name && name !== channel) place = "#" + name;
	return event.thread_ts && event.thread_ts !== event.ts ? "a thread in " + place : place;
}
function intakeResponse(attempt, status, accepted) {
	if ((status === 0 || status >= 500) && attempt === 1) return "retry";
	if (status !== 200) return "fail";
	return accepted ? "accept" : "decline";
}
function issueNote(result) {
	return "[autolinear: Leon sent this in " + (result.source || "Slack") + ". It is now " + result.issue.identifier + " (" + result.issue.url + "), and this is its channel, #" + result.channel.name + ": answer here and keep the conversation here.]";
}
function copiedMessage(event, result, from, ts, omit) {
	return {
		...Object.fromEntries(Object.entries(event).filter(([key]) => !omit.includes(key))),
		channel: result.channel.id,
		ts: result.ts,
		event_ts: result.ts,
		channel_type: "group",
		_autolinear: {
			from_channel: from,
			from_ts: ts,
			issue: result.issue.identifier
		}
	};
}
function delegationRequest({ channel, ts, thread, originChannel, originTs, text, context, issue }) {
	const origin = "slack:" + originChannel + "/" + originTs;
	const marker = "SESSION_LINK " + origin + " ";
	return {
		marker,
		payload: {
			text: "Start or resume the Codex task for my Slack request: " + ("https://app.slack.com/archives/" + channel + "/p" + ts.replaceAll(".", "")) + "\nReply in this Beeper chat with one plain-text line: " + marker + "<private https://chatgpt.com session URL>\nKeep the " + origin + " reference exactly as written so Hermes can post the link in Slack. Use the session’s signed-in URL and keep its contents private.\n\nRequest:\n" + Array.from(text).slice(0, 12e3).join("") + "\n\nSlack context and files:\n" + Array.from(context).slice(-5e3).join("") + (issue ? "\n\nKeep this Linear issue's title and Slack channel name. Create a separate Linear issue for new work, link it to this issue, and let the sync open its own Slack channel." : ""),
			slack_channel: channel,
			slack_thread_ts: thread,
			idempotency_key: "autolinear:slack:" + originChannel + ":" + originTs
		}
	};
}
exports.answersForSure = answersForSure;
exports.copiedMessage = copiedMessage;
exports.delegationRequest = delegationRequest;
exports.intakeResponse = intakeResponse;
exports.issueNote = issueNote;
exports.ordinary = ordinary;
exports.turnRoute = turnRoute;
exports.where = where;
