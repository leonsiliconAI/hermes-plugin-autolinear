import { agentGroup, marker, slackPermalink } from "#slack";

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
  event: Message | undefined,
  quickDelegate: boolean,
  isBot: boolean,
  replyExpected: boolean,
) {
  if (quickDelegate && !isBot && replyExpected && !event?._slack_changed_event_ts)
    return "delegate";
  if (agentGroup(event?.client_msg_id)) return "report";
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
  const permalink = slackPermalink(channel, ts);
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

const delegationPrompt =
  "Leon's rule: always hand off every task to another agent before starting the work. Use your task-routing tools to dispatch it and give the agent the context it needs. You own the coordination, follow-up, and reporting. Route any remaining work back to the assigned agent or hand it to another available agent. If a handoff fails, try another agent. If no agent can take it, report what blocked delegation. Dispatch through a tool that returns before the assigned agent finishes. End your turn after the handoff. For a handoff through another service, include where Leon asked so you can route the result back. When the result comes back, verify it and give Leon the substantive answer in the same Slack conversation.";
export function taskPrompt(inIssue: boolean, report: boolean, bot: string) {
  if (!inIssue) return delegationPrompt;
  const mention = bot ? "<@" + bot + ">" : "@Autolinear";
  const instructions = report
    ? "This is a report from an agent already assigned to the task. Follow up if they " +
      "need coordination, and update Leon when there is something he needs to know. " +
      "If there is no action or meaningful update, return NO_REPLY. " +
      "Send one Autolinear command only if this report calls for a different issue status. " +
      "If the status should stay the same, omit the command entirely, even if earlier " +
      "turns used `stay`. Do not post `stay` for a delegated agent's report. "
    : delegationPrompt +
      "\n\n" +
      "This is a Linear issue's channel. End the turn with one line of its own that tells " +
      "Autolinear what to do with the channel. ";
  const stay = report ? "" : ", or `stay` (leave the status as it is)";
  const dispatch = report
    ? ""
    : "For a new task, send `move executing` after the handoff succeeds and end the turn. " +
      "When the result comes back, give Leon the answer and move the issue based on the result. ";
  const reminder = report
    ? ""
    : " When you forget, Autolinear reminds you here. Answer it with the line.";
  return (
    issueScope +
    " " +
    instructions +
    "Start that line with " +
    mention +
    ", written exactly so, then one of: " +
    "`move done` (nothing is left for anyone, even after a thanks), " +
    "`move leon` (Leon needs to see, decide or do something; mention him in your message), " +
    '`move trigger --who "<who>"` (waiting on someone else), ' +
    '`move trigger --event "<what>" --stop YYYY-MM-DD` (waiting for an event until a stop date), ' +
    "`move date --start <RFC 3339 time or YYYY-MM-DD>` (work starts later), " +
    "`move executing` (a delegated agent is working on it)" +
    stay +
    ". " +
    dispatch +
    "Set the issue status through Autolinear. Mentioning Leon only notifies him." +
    reminder +
    " When Autolinear says a command didn't work, send a corrected line."
  );
}

export function applyPrompt(
  current: string | undefined,
  inIssue: boolean,
  report: boolean,
  bot: string,
) {
  return {
    prompt: [current, taskPrompt(inIssue, report, bot)].filter(Boolean).join("\n\n"),
    silent: inIssue && report,
  };
}

interface IntakeHost {
  post(): Promise<{
    status: number;
    body?: Result & { ok?: boolean; error?: string; skipped?: string };
  }>;
  retry(): Promise<void>;
}

export async function requestIntake(host: IntakeHost) {
  for (const attempt of [1, 2]) {
    const { status, body } = await host.post();
    const action = intakeResponse(attempt, status, Boolean(body?.ok));
    if (action === "retry") {
      await host.retry();
    } else if (status === 0) {
      return { networkError: true };
    } else if (action === "fail") {
      return { error: "autolinear answered " + status + ": " + (body?.error ?? "None") };
    } else if (action === "accept") {
      return { accepted: body };
    } else {
      return { skipped: body?.skipped };
    }
  }
  return {};
}

interface Attachment {
  name?: string;
  title?: string;
  permalink?: string;
}

function files(event: Message): Attachment[] {
  if (!Array.isArray(event.files)) return [];
  return event.files.filter(
    (file): file is Attachment => Boolean(file) && typeof file === "object" && !Array.isArray(file),
  );
}

export function intakePayload(event: Message, channel: string, ts: string, name: string) {
  const attachments = files(event).map((file) => ({
    name: file.name || "",
    title: file.title || "",
    permalink: file.permalink || "",
  }));
  return {
    channel,
    ts,
    thread_ts: event.thread_ts && event.thread_ts !== ts ? event.thread_ts : null,
    user: String(event.user || ""),
    text: String(event.text || ""),
    where: where(event, channel, name),
    ...(Array.isArray(event.blocks) ? { blocks: event.blocks } : {}),
    ...(attachments.length ? { files: attachments } : {}),
  };
}

export function canMove(
  event: Message | undefined,
  sender: string,
  owner: string | undefined,
  command: boolean,
) {
  return Boolean(owner && sender === owner && !command && event && ordinary(event));
}

export function shouldReact(event: Message, ts: string) {
  return Boolean(ts && !event?._slack_changed_event_ts);
}

export function selectDotRoom(listing: {
  conversations: { name?: string; room_id: string }[];
  next_offset?: number;
}) {
  const rooms = listing.conversations.filter((room) => room.name?.toLowerCase() === "silicon dot");
  if (rooms.length === 1 && listing.next_offset == null) return rooms[0].room_id;
}

interface JournalHost {
  page(cursor: number): Promise<{
    cursor: number;
    entries: { isMe: boolean; redacted: boolean; text: string }[];
  }>;
  sleep(): Promise<void>;
}

export async function waitForLink(host: JournalHost, cursor: number, marker: string) {
  for (;;) {
    const page = await host.page(cursor);
    for (const entry of page.entries) {
      if (entry.isMe || entry.redacted) continue;
      // oxlint-disable-next-line no-control-regex -- Match Python str.splitlines for old journal entries.
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

interface DelegationHost {
  room(): Promise<string>;
  beeper(
    kind: "send" | "journal",
    payload: Record<string, string | number>,
  ): Promise<{
    status?: string;
    event_id?: string;
    head?: number;
  }>;
  waitForLink(room: string, cursor: number, marker: string): Promise<string | undefined>;
  reply(text: string): Promise<void>;
  warn(stage: string, error: string): void;
}

export async function delegate(
  host: DelegationHost,
  turn: Omit<Delegation, "originChannel" | "originTs"> & {
    dm: boolean;
    event: Message & { _autolinear?: { from_channel?: string; from_ts?: string } };
  },
) {
  if (turn.dm) {
    await host.reply("I couldn’t open a Slack task channel for the Codex handoff.");
    return;
  }
  const moved = turn.event._autolinear;
  const context = [turn.context, ...files(turn.event).map((file) => file.permalink)]
    .filter(Boolean)
    .join("\n");
  const request = delegationRequest({
    ...turn,
    originChannel: moved?.from_channel ?? turn.channel,
    originTs: moved?.from_ts ?? turn.ts,
    context,
  });
  let room;
  try {
    room = await host.room();
    const receipt = await host.beeper("send", { room_id: room, ...request.payload });
    if (receipt.status !== "sent" || !receipt.event_id)
      throw new Error("Beeper did not confirm the handoff");
  } catch (error) {
    host.warn("confirm Codex handoff", error instanceof Error ? error.message : String(error));
    await host.reply("I couldn’t confirm the Codex handoff.");
    return;
  }
  let link;
  try {
    const journal = await host.beeper("journal", { room_id: room, limit: 1 });
    // Start just before the journal tail to cover replies written while Beeper verifies the send.
    if (journal.head === undefined) throw new Error("Beeper journal omitted its head");
    link = await host.waitForLink(room, Math.max(0, journal.head - 100), request.marker);
  } catch (error) {
    host.warn(
      "read the Codex session link",
      error instanceof Error ? error.message : String(error),
    );
  }
  await host.reply(
    link
      ? "<" + link.replaceAll("&", "&amp;") + "|Open Codex session>"
      : "I handed this to Codex, but the session link hasn’t arrived.",
  );
}

export function issueChannel(name: string, prefix: string) {
  if (!name.startsWith(prefix + "-")) return false;
  return /^\p{Decimal_Number}+(?:-|$)/u.test(name.slice(prefix.length + 1));
}

interface BuildHost {
  build(mode: "native" | "local" | "moved", quickDelegate: boolean): Promise<boolean>;
  move(): Promise<boolean>;
}

export async function buildReply(
  host: BuildHost,
  event: Message | undefined,
  sender: string,
  owner: string | undefined,
  command: boolean,
  museOwns: boolean,
) {
  if (museOwns) {
    await host.build("native", false);
  } else if (!canMove(event, sender, owner, command)) {
    await host.build("local", false);
  } else if (!(await host.move()) || !(await host.build("moved", true))) {
    await host.build("local", true);
  }
}
