Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const groups = {
	grok: "b075",
	codex: "c0de"
};
function agentGroup(id) {
	if (typeof id === "string") return Object.values(groups).find((group) => id.startsWith("de1e6a7e-" + group + "-"));
}
function slackPermalink(channel, ts) {
	return "https://app.slack.com/archives/" + channel + "/p" + ts.replaceAll(".", "");
}
// policy.ts
const issueScope = "Keep this Linear issue's title and Slack channel name. Create a separate Linear issue for new work, link it to this issue, and let the sync open its own Slack channel.";
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
	if (quickDelegate && !isBot && replyExpected && !event?._slack_changed_event_ts) return "delegate";
	if (agentGroup(event?.client_msg_id)) return "report";
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
			text: "Start or resume the Codex task for my Slack request: " + slackPermalink(channel, ts) + "\nReply in this Beeper chat with one plain-text line: " + marker + "<private https://chatgpt.com session URL>\nKeep the " + origin + " reference exactly as written so Hermes can post the link in Slack. Use the session’s signed-in URL and keep its contents private.\n\nRequest:\n" + Array.from(text).slice(0, 12e3).join("") + "\n\nSlack context and files:\n" + Array.from(context).slice(-5e3).join("") + (issue ? "\n\n" + issueScope : ""),
			slack_channel: channel,
			slack_thread_ts: thread,
			idempotency_key: "autolinear:slack:" + originChannel + ":" + originTs
		}
	};
}
const delegationPrompt = "Leon's rule: always hand off every task to another agent before starting the work. Use your task-routing tools to dispatch it and give the agent the context it needs. You own the coordination, follow-up, and reporting. Route any remaining work back to the assigned agent or hand it to another available agent. If a handoff fails, try another agent. If no agent can take it, report what blocked delegation. Dispatch through a tool that returns before the assigned agent finishes. End your turn after the handoff. For a handoff through another service, include where Leon asked so you can route the result back. When the result comes back, verify it and give Leon the substantive answer in the same Slack conversation.";
function taskPrompt(inIssue, report, bot, muse = false) {
	if (!inIssue) return muse ? "" : delegationPrompt;
	const mention = bot ? "<@" + bot + ">" : "@Autolinear";
	const instructions = report ? "This is a report from an agent already assigned to the task. Follow up if they need coordination, and update Leon when there is something he needs to know. If there is no action or meaningful update, return NO_REPLY. Send one Autolinear command only if this report calls for a different issue status. If the status should stay the same, omit the command entirely, even if earlier turns used `stay`. Do not post `stay` for a delegated agent's report. " : (muse ? "" : delegationPrompt + "\n\n") + "This is a Linear issue's channel. End the turn with one line of its own that tells Autolinear what to do with the channel. ";
	const stay = report ? "" : ", or `stay` (leave the status as it is)";
	const dispatch = report ? "" : muse ? "After a Muse handoff, give Leon the checked answer here and move the issue based on the result. " : "For a new task, send `move executing` after the handoff succeeds and end the turn. When the result comes back, give Leon the answer and move the issue based on the result. ";
	const reminder = report ? "" : " When you forget, Autolinear reminds you here. Answer it with the line.";
	return issueScope + " " + instructions + "Start that line with " + mention + ", written exactly so, then one of: `move done` (nothing is left for anyone, even after a thanks), `move leon` (Leon needs to see, decide or do something; mention him in your message), `move trigger --who \"<who>\"` (waiting on someone else), `move trigger --event \"<what>\" --stop YYYY-MM-DD` (waiting for an event until a stop date), `move date --start <RFC 3339 time or YYYY-MM-DD>` (work starts later), `move executing` (a delegated agent is working on it)" + stay + ". " + dispatch + "Set the issue status through Autolinear. Mentioning Leon only notifies him." + reminder + " When Autolinear says a command didn't work, send a corrected line.";
}
function applyPrompt(current, inIssue, report, bot, muse = false) {
	return {
		prompt: [current, taskPrompt(inIssue, report, bot, muse)].filter(Boolean).join("\n\n"),
		silent: inIssue && report
	};
}
async function requestIntake(host) {
	for (const attempt of [1, 2]) {
		const { status, body } = await host.post();
		const action = intakeResponse(attempt, status, Boolean(body?.ok));
		if (action === "retry") await host.retry();
		else if (status === 0) return { networkError: true };
		else if (action === "fail") return { error: "autolinear answered " + status + ": " + (body?.error ?? "None") };
		else if (action === "accept") return { accepted: body };
		else return { skipped: body?.skipped };
	}
	return {};
}
function files(event) {
	if (!Array.isArray(event.files)) return [];
	return event.files.filter((file) => Boolean(file) && typeof file === "object" && !Array.isArray(file));
}
function intakePayload(event, channel, ts, name) {
	const attachments = files(event).map((file) => ({
		name: file.name || "",
		title: file.title || "",
		permalink: file.permalink || ""
	}));
	return {
		channel,
		ts,
		thread_ts: event.thread_ts && event.thread_ts !== ts ? event.thread_ts : null,
		user: String(event.user || ""),
		text: String(event.text || ""),
		where: where(event, channel, name),
		...Array.isArray(event.blocks) ? { blocks: event.blocks } : {},
		...attachments.length ? { files: attachments } : {}
	};
}
function canMove(event, sender, owner, command) {
	return Boolean(owner && sender === owner && !command && event && ordinary(event));
}
function shouldReact(event, ts) {
	return Boolean(ts && !event?._slack_changed_event_ts);
}
function selectDotRoom(listing) {
	const rooms = listing.conversations.filter((room) => room.name?.toLowerCase() === "silicon dot");
	if (rooms.length === 1 && listing.next_offset == null) return rooms[0].room_id;
}
async function waitForLink(host, cursor, marker) {
	for (;;) {
		const page = await host.page(cursor);
		for (const entry of page.entries) {
			if (entry.isMe || entry.redacted) continue;
			for (const line of entry.text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)) {
				const text = line.trim();
				if (!text.startsWith(marker)) continue;
				const link = text.slice(marker.length);
				if (/^https:\/\/chatgpt\.com\/(?:c|codex)\/[^\s<>|]+$/.test(link)) return link;
			}
		}
		if (page.cursor === cursor) await host.sleep();
		cursor = page.cursor;
	}
}
async function delegate(host, turn) {
	if (turn.dm) {
		await host.reply("I couldn’t open a Slack task channel for the Codex handoff.");
		return;
	}
	const moved = turn.event._autolinear;
	const context = [turn.context, ...files(turn.event).map((file) => file.permalink)].filter(Boolean).join("\n");
	const request = delegationRequest({
		...turn,
		originChannel: moved?.from_channel ?? turn.channel,
		originTs: moved?.from_ts ?? turn.ts,
		context
	});
	let room;
	try {
		room = await host.room();
		const receipt = await host.beeper("send", {
			room_id: room,
			...request.payload
		});
		if (receipt.status !== "sent" || !receipt.event_id) throw new Error("Beeper did not confirm the handoff");
	} catch (error) {
		host.warn("confirm Codex handoff", error instanceof Error ? error.message : String(error));
		await host.reply("I couldn’t confirm the Codex handoff.");
		return;
	}
	let link;
	try {
		const journal = await host.beeper("journal", {
			room_id: room,
			limit: 1
		});
		if (journal.head === void 0) throw new Error("Beeper journal omitted its head");
		link = await host.waitForLink(room, Math.max(0, journal.head - 100), request.marker);
	} catch (error) {
		host.warn("read the Codex session link", error instanceof Error ? error.message : String(error));
	}
	await host.reply(link ? "<" + link.replaceAll("&", "&amp;") + "|Open Codex session>" : "I handed this to Codex, but the session link hasn’t arrived.");
}
function issueChannel(name, prefix) {
	if (!name.startsWith(prefix + "-")) return false;
	return /^\p{Decimal_Number}+(?:-|$)/u.test(name.slice(prefix.length + 1));
}
async function buildReply(host, event, sender, owner, command, museOwns) {
	const quickDelegate = !museOwns;
	if (!canMove(event, sender, owner, command)) await host.build("local", false);
	else if (!await host.move() || !await host.build("moved", quickDelegate)) await host.build("local", quickDelegate);
}
exports.answersForSure = answersForSure;
exports.applyPrompt = applyPrompt;
exports.buildReply = buildReply;
exports.canMove = canMove;
exports.copiedMessage = copiedMessage;
exports.delegate = delegate;
exports.delegationRequest = delegationRequest;
exports.intakePayload = intakePayload;
exports.intakeResponse = intakeResponse;
exports.issueChannel = issueChannel;
exports.issueNote = issueNote;
exports.ordinary = ordinary;
exports.requestIntake = requestIntake;
exports.selectDotRoom = selectDotRoom;
exports.shouldReact = shouldReact;
exports.taskPrompt = taskPrompt;
exports.turnRoute = turnRoute;
exports.waitForLink = waitForLink;
exports.where = where;
