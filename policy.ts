type Message = Record<string, unknown> & {
  client_msg_id?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
};

interface Result {
  source?: string;
  issue: { identifier: string; url: string };
  channel: { id: string; name: string };
  ts: string;
}

const marker = "de1e6a7e";
const issueScope =
  "Keep this Linear issue's title and Slack channel name. Create a separate Linear issue " +
  "for new work, link it to this issue, and let the sync open its own Slack channel.";

export function ordinary(event: Message) {
  return !(
    event._hermes_reaction ||
    event._hermes_force_process ||
    event.bot_id ||
    (typeof event.client_msg_id === "string" && event.client_msg_id.startsWith(marker + "-"))
  );
}

export function answersForSure(event: Message, user: string, bot?: string) {
  if (event._slack_changed_event_ts || event.user !== user || !ordinary(event)) return false;
  const text = String(event.text || "");
  const command = bot ? text.replaceAll("<@" + bot + ">", "") : text;
  return (
    !/^[!/]/.test(command.trimStart()) &&
    [...text.matchAll(/<@([UW][A-Z0-9]+)/g)].every((match) => match[1] === bot)
  );
}

export function turnRoute(
  event: Message,
  quickDelegate: boolean,
  isBot: boolean,
  replyExpected: boolean,
) {
  if (quickDelegate && !isBot && replyExpected && !event._slack_changed_event_ts) return "delegate";
  if (typeof event.client_msg_id === "string" && /^de1e6a7e-(b075|c0de)-/.test(event.client_msg_id))
    return "report";
  return "standard";
}

export function where(event: Message, channel: string, name: string) {
  const kind = event.channel_type || (channel.startsWith("D") ? "im" : "");
  let place = "a channel";
  if (kind === "im") place = "a DM with Hermes";
  else if (kind === "mpim") place = "a group DM";
  else if (name && name !== channel) place = "#" + name;
  return event.thread_ts && event.thread_ts !== event.ts ? "a thread in " + place : place;
}

export function intakeResponse(attempt: number, status: number, accepted: boolean) {
  if ((status === 0 || status >= 500) && attempt === 1) return "retry";
  if (status !== 200) return "fail";
  return accepted ? "accept" : "decline";
}

export function issueNote(result: Result) {
  return (
    "[autolinear: Leon sent this in " +
    (result.source || "Slack") +
    ". It is now " +
    result.issue.identifier +
    " (" +
    result.issue.url +
    "), and this is its channel, #" +
    result.channel.name +
    ": answer here and keep the conversation here.]"
  );
}

export function copiedMessage(
  event: Message,
  result: Result,
  from: string,
  ts: string,
  omit: string[],
) {
  return {
    ...Object.fromEntries(Object.entries(event).filter(([key]) => !omit.includes(key))),
    channel: result.channel.id,
    ts: result.ts,
    event_ts: result.ts,
    channel_type: "group",
    _autolinear: { from_channel: from, from_ts: ts, issue: result.issue.identifier },
  };
}

interface Delegation {
  channel: string;
  ts: string;
  thread: string;
  originChannel: string;
  originTs: string;
  text: string;
  context: string;
  issue: boolean;
}

export function delegationRequest({
  channel,
  ts,
  thread,
  originChannel,
  originTs,
  text,
  context,
  issue,
}: Delegation) {
  const origin = "slack:" + originChannel + "/" + originTs;
  const marker = "SESSION_LINK " + origin + " ";
  const permalink = "https://app.slack.com/archives/" + channel + "/p" + ts.replaceAll(".", "");
  // The Beeper send limit includes the additional instructions appended by the Beeper tool.
  const prompt =
    "Start or resume the Codex task for my Slack request: " +
    permalink +
    "\n" +
    "Reply in this Beeper chat with one plain-text line: " +
    marker +
    "<private https://chatgpt.com session URL>\n" +
    "Keep the " +
    origin +
    " reference exactly as written so Hermes can post the link in Slack. " +
    "Use the session’s signed-in URL and keep its contents private.\n\n" +
    "Request:\n" +
    Array.from(text).slice(0, 12000).join("") +
    "\n\nSlack context and files:\n" +
    Array.from(context).slice(-5000).join("") +
    (issue ? "\n\n" + issueScope : "");
  return {
    marker,
    payload: {
      text: prompt,
      slack_channel: channel,
      slack_thread_ts: thread,
      idempotency_key: "autolinear:slack:" + originChannel + ":" + originTs,
    },
  };
}
