"""Give each of Leon's Slack messages its own Linear issue and channel the moment it arrives.

Leon's rule (2026-11-21): every message he sends Hermes in Slack outside an issue channel becomes a
new Linear issue in Awaiting Init (the team's default status) with its own channel, at once; his
message is edited to link the channel, and Hermes answers, and keeps the conversation going, there.

autolinear (autolinear.leonsilicon.ai) does the work: it creates the issue and the channel, edits
Leon's message, and posts the message again in the channel as Leon, marked like slack-as-leon's
posts, then answers with the channel and the copy's ts. The plugin wraps three seams of the live Slack adapter:

- ``_prefilter_inbound``: the moment one of Leon's messages has passed dedup and the bot check, it
  starts the request in the background, before Hermes reads the thread or downloads files. Only
  messages Hermes is sure to answer start this early: Leon's, outside an issue channel, not a
  command, mentioning no one but Hermes.
- ``_build_message_event``: runs only after every gate (auth, channel, mention, bot) has accepted a
  message, so it sees exactly the messages Hermes answers. It waits for the request started early,
  or starts it then, and builds the turn as if Leon had written the copy: same text, files and
  thread history, in the new channel.
- ``handle_message``: reacts with 👀 and hands fresh requests to Silicon Dot through Beeper.
  It relays the Codex session link to Slack without starting a Hermes model turn.

Slack task turns get Leon's delegation rule in their channel prompt. In an issue channel, Hermes
ends ordinary turns with an explicit Autolinear command. Reports from delegated agents can be
handled silently and only get a command when the report calls for a status change.

The copy's own event carries slack-as-leon's marker, so ``slack-as-leon-guard`` drops it and Hermes
doesn't answer the message twice. That plugin must be enabled too.

When autolinear can't complete intake, a channel request can hand off in place. If the adapter
internals change, the plugin logs a warning and leaves the adapter alone.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_PATCHED_ATTR = "_autolinear_patched"
_PENDING_ATTR = "_autolinear_pending"
_QUICK_DELEGATE = "_autolinear_quick_delegate"
_warned_guard = False

#: Settings, from Hermes's environment ($HERMES_HOME/.env). Without the first two, the plugin is off.
TOKEN_ENV = "AUTOLINEAR_TOKEN"
USER_ENV = "AUTOLINEAR_USER_ID"  # Leon's Slack user ID
URL_ENV = "AUTOLINEAR_URL"
PREFIX_ENV = "AUTOLINEAR_CHANNEL_PREFIX"
SKIP_ENV = "AUTOLINEAR_SKIP_CHANNELS"
#: Autolinear's bot user, whose mention starts Hermes's command line. Without it, the prompt asks for a
#: plain "@Autolinear", which Autolinear reads too.
BOT_ENV = "AUTOLINEAR_BOT_USER_ID"
DOT_ROOM_ENV = "AUTOLINEAR_DOT_ROOM_ID"

DEFAULT_URL = "https://autolinear.leonsilicon.ai/intake"
DEFAULT_PREFIX = "leon"
#: First group of the client_msg_id on posts made as Leon by slack-as-leon and autolinear.
MARKER = "de1e6a7e"
#: Grok Bot and Codex report markers, matching slack-as-leon-guard.
_AGENT_REPORTS = (f"{MARKER}-b075-", f"{MARKER}-c0de-")
TIMEOUT_SECONDS = 20.0
RETRY_DELAY_SECONDS = 1.0
#: How long building a turn waits for its intake before answering in place.
WAIT_SECONDS = 25.0
REACTION_TIMEOUT_SECONDS = 2.0
SESSION_LINK_TIMEOUT_SECONDS = 180.0
SESSION_LINK_POLL_SECONDS = 2.0
#: How long an intake nobody waited for is kept, in case its turn is still being built.
KEEP_SECONDS = 120.0

# Thread bookkeeping that belongs to where the message was, not to its copy at the top of a channel.
_THREAD_KEYS = (
    "thread_ts", "parent_user_id", "reply_count", "reply_users", "reply_users_count",
    "latest_reply", "replies", "subscribed", "last_read", "edited", "_slack_changed_event_ts",
)
_MENTION = re.compile(r"<@([UW][A-Z0-9]+)")
_DELEGATION_PROMPT = (
    "Leon's rule: always hand off every task to another agent before starting the work. "
    "Use your task-routing tools to dispatch it and give the agent the context it needs. "
    "You own the coordination, follow-up, and reporting. Route any remaining work back to the "
    "assigned agent or hand it to another available agent. If a handoff fails, try another agent. "
    "If no agent can take it, report what blocked delegation. Dispatch through a tool that returns "
    "before the assigned agent finishes. End your turn after the handoff. For a handoff through "
    "another service, include where Leon asked so you can route the result back. When the result "
    "comes back, verify it and give Leon the substantive answer in the same Slack conversation."
)

_ISSUE_SCOPE_PROMPT = (
    "Keep this Linear issue's title and Slack channel name. Create a separate Linear issue "
    "for new work, link it to this issue, and let the sync open its own Slack channel."
)


def _handoff_prompt(*, agent_report: bool = False) -> str:
    """Autolinear's rule for a turn in an issue channel, with its mention spelled out: Hermes's Slack
    adapter shows every mention it reads as a plain @Name, so the raw token has to come from here."""
    bot = os.environ.get(BOT_ENV, "").strip()
    mention = f"<@{bot}>" if bot else "@Autolinear"
    if agent_report:
        instructions = (
            "This is a report from an agent already assigned to the task. Follow up if they "
            "need coordination, and update Leon when there is something he needs to know. "
            "If there is no action or meaningful update, return NO_REPLY. "
            "Send one Autolinear command only if this report calls for a different issue status. "
            "If the status should stay the same, omit the command entirely, even if earlier "
            "turns used `stay`. Do not post `stay` for a delegated agent's report. "
        )
        stay = ""
        reminder = ""
        dispatch_note = ""
    else:
        instructions = (
            f"{_DELEGATION_PROMPT}\n\n"
            "This is a Linear issue's channel. End the turn with one line of its own that tells "
            "Autolinear what to do with the channel. "
        )
        stay = ", or `stay` (leave the status as it is)"
        reminder = " When you forget, Autolinear reminds you here. Answer it with the line."
        dispatch_note = (
            "For a new task, send `move executing` after the handoff succeeds and end the turn. "
            "When the result comes back, give Leon the answer and move the issue based on the result. "
        )
    return (
        f"{_ISSUE_SCOPE_PROMPT} {instructions}Start that line with {mention}, "
        "written exactly so, then one of: "
        "`move done` (nothing is left for anyone, even after a thanks), "
        "`move leon` (Leon needs to see, decide or do something; mention him in your message), "
        "`move trigger --who \"<who>\"` (waiting on someone else), "
        "`move trigger --event \"<what>\" --stop YYYY-MM-DD` (waiting for an event until a stop date), "
        "`move date --start <RFC 3339 time or YYYY-MM-DD>` (work starts later), "
        f"`move executing` (a delegated agent is working on it){stay}. "
        f"{dispatch_note}"
        "Set the issue status through Autolinear. Mentioning Leon only notifies him."
        f"{reminder} When Autolinear says a command didn't work, send a corrected line."
    )


def _settings() -> Optional[dict[str, Any]]:
    """Read on every message, so a change to Hermes's env applies without rewiring."""
    token = os.environ.get(TOKEN_ENV, "").strip()
    user = os.environ.get(USER_ENV, "").strip()
    if not token or not user:
        return None
    prefix = os.environ.get(PREFIX_ENV, "").strip() or DEFAULT_PREFIX
    return {
        "token": token,
        "user": user,
        "url": os.environ.get(URL_ENV, "").strip() or DEFAULT_URL,
        "issue_channel": re.compile(rf"^{re.escape(prefix)}-\d+(?:-|$)"),
        "skip": {c.strip() for c in os.environ.get(SKIP_ENV, "").split(",") if c.strip()},
    }


def _post_json(url: str, token: str, payload: dict, timeout: float) -> tuple[int, dict]:
    """One POST. Returns the status and JSON body; raises on a network failure."""
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            # Cloudflare refuses some default user agents on this zone.
            "user-agent": "hermes-autolinear/1.0",
        })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        body = error.read() or b""
        try:
            return error.code, json.loads(body)
        except ValueError:
            return error.code, {"error": body[:200].decode(errors="replace")}


async def _request_intake(settings: dict, payload: dict) -> Optional[dict]:
    """Asks autolinear for the issue. Retries once on a network error or a 5xx: an intake runs
    once per message, so a retry gets the same issue. None when it declines; raises on failure."""
    for attempt in (1, 2):
        try:
            status, body = await asyncio.to_thread(
                _post_json, settings["url"], settings["token"], payload, TIMEOUT_SECONDS)
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == 2:
                raise
            await asyncio.sleep(RETRY_DELAY_SECONDS)
            continue
        if status >= 500 and attempt == 1:
            await asyncio.sleep(RETRY_DELAY_SECONDS)
            continue
        if status != 200:
            raise RuntimeError(f"autolinear answered {status}: {body.get('error')}")
        if body.get("ok"):
            return body
        logger.info(
            "autolinear: left %s:%s alone (%s); answering it there",
            payload["channel"], payload["ts"], body.get("skipped"))
        return None
    return None


def _pending(adapter) -> dict:
    pending = getattr(adapter, _PENDING_ATTR, None)
    if pending is None:
        pending = {}
        setattr(adapter, _PENDING_ATTR, pending)
    return pending


def _is_marked(event: dict) -> bool:
    value = event.get("client_msg_id")
    return isinstance(value, str) and value.startswith(f"{MARKER}-")


def _is_ordinary_message(event: dict) -> bool:
    return not (event.get("_hermes_reaction") or event.get("_hermes_force_process")
                or event.get("bot_id") or _is_marked(event))


async def _react_during_intake(adapter, channel_id, ts, team_id, intake) -> None:
    """Show receipt on the source while the issue channel is being opened."""
    try:
        added = await asyncio.wait_for(
            adapter._add_reaction(channel_id, ts, "eyes", team_id), REACTION_TIMEOUT_SECONDS)
        if not added:
            return
        result = await asyncio.shield(intake)
        if result is not None:
            await asyncio.wait_for(
                adapter._remove_reaction(channel_id, ts, "eyes", team_id), REACTION_TIMEOUT_SECONDS)
    except Exception:
        logger.debug("autolinear: could not show intake receipt for %s:%s", channel_id, ts, exc_info=True)


async def _beeper(*args: str, payload: dict) -> dict:
    """Call Beeper's existing local client. Its daemon owns the account and the send ledger."""
    home = Path(os.environ.get("BEEPER_INBOX_HOME") or
                Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "beeper-inbox")
    process = await asyncio.create_subprocess_exec(
        "node", str(home / "app" / "beeper-inbox.mjs"), *args, json.dumps(payload),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), 40)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        raise RuntimeError(f"Beeper inbox {' '.join(args)} exited with {process.returncode}")
    return json.loads(stdout)


async def _dot_room() -> str:
    configured = os.environ.get(DOT_ROOM_ENV, "").strip()
    if configured:
        return configured
    listing = await _beeper("tool", "list_conversations", payload={
        "query": "Silicon Dot", "network": "chatgpt", "direct_only": True, "limit": 100,
    })
    matches = [room["room_id"] for room in listing["conversations"]
               if (room.get("name") or "").casefold() == "silicon dot"]
    if len(matches) != 1 or listing.get("next_offset") is not None:
        raise RuntimeError(f"Silicon Dot's Beeper chat is ambiguous or absent; set {DOT_ROOM_ENV}")
    return matches[0]


async def _wait_for_session_link(room: str, cursor: int, marker: str) -> Optional[str]:
    """Use the sync journal to match Dot's reply to this specific Slack request."""
    session_line = re.compile(re.escape(marker) + r"(https://chatgpt\.com/(?:c|codex)/[^\s<>|]+)")
    try:
        async with asyncio.timeout(SESSION_LINK_TIMEOUT_SECONDS):
            while True:
                page = await _beeper("journal", payload={
                    "room_id": room, "after": cursor, "text": True,
                })
                for entry in page["entries"]:
                    if entry["isMe"] or entry["redacted"]:
                        continue
                    for line in entry["text"].splitlines():
                        match = session_line.fullmatch(line.strip())
                        if match:
                            return match[1]
                if page["cursor"] == cursor:
                    await asyncio.sleep(SESSION_LINK_POLL_SECONDS)
                cursor = page["cursor"]
    except TimeoutError:
        return None


async def _send_delegation_reply(adapter, turn, text: str) -> None:
    from gateway.platforms.base import _reply_anchor_for_event, _thread_metadata_for_event

    source = turn.source
    channel = source.chat_id
    try:
        if adapter._outbound_blocked(channel, "autolinear delegation reply to"):
            return
        params = {"channel": channel, "text": text, "unfurl_links": False, "unfurl_media": False}
        thread_ts = adapter._resolve_thread_ts(
            _reply_anchor_for_event(turn), _thread_metadata_for_event(turn))
        if thread_ts:
            params["thread_ts"] = thread_ts
        client = adapter._get_client(channel, team_id=source.scope_id)
        await asyncio.wait_for(client.chat_postMessage(**params), 10)
    except Exception:
        logger.warning("autolinear: could not post the delegation reply in %s", channel, exc_info=True)


async def _acknowledge(adapter, turn) -> None:
    if adapter._reactions_enabled() and turn.message_id:
        try:
            await asyncio.wait_for(adapter._add_reaction(
                turn.source.chat_id, turn.message_id, "eyes", turn.source.scope_id or ""),
                REACTION_TIMEOUT_SECONDS)
        except Exception:
            logger.debug("autolinear: could not react to the request", exc_info=True)


async def _delegate(adapter, turn) -> None:
    """Hand off the request and relay the link without entering the Hermes model loop."""
    source = turn.source
    channel, ts = source.chat_id, turn.message_id
    if adapter._outbound_blocked(channel, "autolinear delegation from"):
        return
    moved = turn.raw_message.get("_autolinear") or {}
    origin_channel = moved.get("from_channel", channel)
    origin_ts = moved.get("from_ts", ts)
    origin = f"slack:{origin_channel}/{origin_ts}"
    marker = f"SESSION_LINK {origin} "
    if source.chat_type == "dm":
        await _send_delegation_reply(
            adapter, turn, "I couldn’t open a Slack task channel for the Codex handoff.")
        return
    thread_ts = source.thread_id or ts
    permalink = f"https://app.slack.com/archives/{channel}/p{ts.replace('.', '')}"
    attachments = [f["permalink"] for f in turn.raw_message.get("files") or []
                   if isinstance(f, dict) and f.get("permalink")]
    context = "\n".join(filter(None, (turn.channel_context, *attachments)))
    issue_scope = turn.raw_message[_QUICK_DELEGATE]["in_issue_channel"]
    # The Beeper send limit is 20,000 characters, including its own handoff instructions.
    text = (f"Start or resume the Codex task for my Slack request: {permalink}\n"
            f"Reply in this Beeper chat with one plain-text line: {marker}<private https://chatgpt.com session URL>\n"
            f"Keep the {origin} reference exactly as written so Hermes can post the link in Slack. "
            "Use the session’s signed-in URL and keep its contents private.\n\n"
            f"Request:\n{turn.text[:12000]}\n\nSlack context and files:\n{context[-5000:]}")
    if issue_scope:
        text += f"\n\n{_ISSUE_SCOPE_PROMPT}"
    try:
        room = await _dot_room()
        result = await _beeper("tool", "send_message", payload={
            "room_id": room, "text": text, "slack_channel": channel, "slack_thread_ts": thread_ts,
            "idempotency_key": f"autolinear:slack:{origin_channel}:{origin_ts}",
        })
        if result.get("status") != "sent" or not result.get("event_id"):
            raise RuntimeError("Beeper did not confirm the handoff")
    except Exception:
        logger.warning("autolinear: could not confirm Codex handoff for %s:%s", channel, ts,
                       exc_info=True)
        await _send_delegation_reply(adapter, turn, "I couldn’t confirm the Codex handoff.")
        return

    try:
        # The request's Slack timestamp makes the marker unique. Start just before the journal
        # tail so an answer that arrived while Beeper verified the send is also visible.
        journal = await _beeper("journal", payload={"room_id": room, "limit": 1})
        link = await _wait_for_session_link(room, max(0, journal["head"] - 100), marker)
    except Exception:
        logger.warning("autolinear: could not read the Codex session link for %s:%s", channel, ts,
                       exc_info=True)
        link = None
    if link:
        await _send_delegation_reply(adapter, turn, f"<{link.replace('&', '&amp;')}|Open Codex session>")
    else:
        await _send_delegation_reply(
            adapter, turn, "I handed this to Codex, but the session link hasn’t arrived.")


def _where(event: dict, channel_id: str, name: str) -> str:
    kind = event.get("channel_type") or ("im" if channel_id.startswith("D") else "")
    place = ("a DM with Hermes" if kind == "im" else "a group DM" if kind == "mpim"
             else f"#{name}" if name and name != channel_id else "a channel")
    thread = event.get("thread_ts")
    return f"a thread in {place}" if thread and thread != event.get("ts") else place


async def _start(adapter, settings: dict, event: dict, channel_id: str, team_id: str,
                 receipt_tasks: set):
    """Starts the intake for a message in the background, unless it's in an issue channel."""
    pending = _pending(adapter)
    ts = str(event.get("ts") or "")
    key = (channel_id, ts)
    if key in pending:
        return pending[key]
    if channel_id in settings["skip"]:
        return None
    name = str(await adapter._resolve_channel_name(channel_id, team_id=team_id) or "")
    if settings["issue_channel"].match(name):
        return None
    global _warned_guard
    if not getattr(adapter, "_slack_as_leon_guard_patched", False) and not _warned_guard:
        _warned_guard = True
        logger.warning(
            "autolinear: slack-as-leon-guard isn't wired, so Hermes may answer the copy of Leon's "
            "message a second time; enable that plugin")
    thread = event.get("thread_ts")
    payload = {
        "channel": channel_id, "ts": ts,
        "thread_ts": thread if thread and thread != ts else None,
        "user": str(event.get("user") or ""),
        "text": str(event.get("text") or ""),
        "where": _where(event, channel_id, name),
    }
    if isinstance(event.get("blocks"), list):
        payload["blocks"] = event["blocks"]
    files = [f for f in event.get("files") or [] if isinstance(f, dict)]
    if files:
        payload["files"] = [
            {"name": f.get("name") or "", "title": f.get("title") or "",
             "permalink": f.get("permalink") or ""} for f in files]
    task = asyncio.ensure_future(_request_intake(settings, payload))
    pending[key] = task
    if ts and not event.get("_slack_changed_event_ts") and adapter._reactions_enabled():
        receipt = asyncio.create_task(_react_during_intake(adapter, channel_id, ts, team_id, task))
        receipt_tasks.add(receipt)
        receipt.add_done_callback(receipt_tasks.discard)

    def forget(_task) -> None:
        # Kept a while for a turn still being built, then dropped; one nobody took is logged.
        def drop() -> None:
            if pending.pop(key, None) is not None and not _task.cancelled():
                result = _task.exception() is None and _task.result()
                if result:
                    logger.warning(
                        "autolinear: made %s for %s:%s, but Hermes didn't answer that message",
                        result["issue"]["identifier"], channel_id, ts)
        asyncio.get_running_loop().call_later(KEEP_SECONDS, drop)

    task.add_done_callback(forget)
    return task


def _answers_for_sure(adapter, settings: dict, event: dict, team_id: str) -> bool:
    """True for a message Hermes always answers: worth starting on before its gates have run."""
    if (event.get("_slack_changed_event_ts") or event.get("user") != settings["user"]
            or not _is_ordinary_message(event)):
        return False
    bot = getattr(adapter, "_team_bot_user_ids", {}).get(team_id) or getattr(
        adapter, "_bot_user_id", None)
    text = str(event.get("text") or "")
    command_probe = text.replace(f"<@{bot}>", "") if bot else text
    if command_probe.lstrip().startswith(("/", "!")):
        return False
    return all(user == bot for user in _MENTION.findall(text))


def _note(result: dict) -> str:
    issue, channel = result["issue"], result["channel"]
    return (
        f"[autolinear: Leon sent this in {result.get('source') or 'Slack'}. It is now "
        f"{issue['identifier']} ({issue['url']}), and this is its channel, #{channel['name']}: "
        "answer here and keep the conversation here.]")


def _add_task_prompt(msg_event, *, in_issue_channel: bool, agent_report: bool = False) -> None:
    prompt = _handoff_prompt(agent_report=agent_report) if in_issue_channel else _DELEGATION_PROMPT
    if in_issue_channel and agent_report:
        msg_event.reply_expected = False
    msg_event.channel_prompt = "\n\n".join(filter(None, (msg_event.channel_prompt, prompt)))


def _remember(adapter, team_id: str, channel_id: str, name: str) -> None:
    """Warm the adapter's caches for the new channel, so building the turn needs no lookups."""
    try:
        if team_id:
            adapter._remember_channel_team(channel_id, team_id)
        cache = getattr(adapter, "_channel_name_cache", None)
        if isinstance(cache, dict) and name:
            cache[(str(team_id or ""), channel_id)] = name
    except Exception:
        logger.debug("autolinear: could not warm caches for %s", channel_id, exc_info=True)


async def _move(adapter, settings: dict, event: dict, kwargs: dict, receipt_tasks: set):
    """``(event, kwargs)`` for the copy in the issue's channel, or None to answer in place."""
    channel_id = str(kwargs.get("channel_id") or "")
    ts = str(kwargs.get("ts") or "")
    team_id = str(kwargs.get("team_id") or "")
    if not channel_id or not ts:
        return None
    task = _pending(adapter).get((channel_id, ts)) or await _start(
        adapter, settings, event, channel_id, team_id, receipt_tasks)
    if task is None:
        return None
    result = await asyncio.wait_for(asyncio.shield(task), WAIT_SECONDS)
    _pending(adapter).pop((channel_id, ts), None)
    if result is None:
        return None
    new_channel, copy_ts = result["channel"]["id"], result["ts"]
    _remember(adapter, team_id, new_channel, result["channel"].get("name", ""))
    moved = {k: v for k, v in event.items() if k not in _THREAD_KEYS}
    moved.update(channel=new_channel, ts=copy_ts, event_ts=copy_ts, channel_type="group")
    moved["_autolinear"] = {
        "from_channel": channel_id, "from_ts": ts, "issue": result["issue"]["identifier"]}
    moved_kwargs = dict(kwargs)
    moved_kwargs.update(
        channel_id=new_channel, ts=copy_ts, is_dm=False,
        thread_ts=adapter._session_thread_ts(moved, copy_ts, False, {}),
        # Leon wrote it to Hermes, wherever he wrote it.
        reply_expected=True,
        text=f"{_note(result)}\n\n{kwargs.get('text') or ''}".rstrip())
    logger.info(
        "autolinear: %s:%s is %s (%s); Hermes answers in #%s", channel_id, ts,
        result["issue"]["identifier"], result.get("ms"), result["channel"].get("name", new_channel))
    return moved, moved_kwargs


def wire(native, adapter) -> None:
    """``register_platform_handler`` factory: patch this adapter instance once."""
    if getattr(adapter, _PATCHED_ATTR, False):
        return
    build = getattr(adapter, "_build_message_event", None)
    prefilter = getattr(adapter, "_prefilter_inbound", None)
    handle = getattr(adapter, "handle_message", None)
    seams = (build, prefilter, handle, getattr(adapter, "_resolve_channel_name", None),
             getattr(adapter, "_session_thread_ts", None),
             getattr(adapter, "_track_reacting_message", None),
             getattr(adapter, "_reactions_enabled", None), getattr(adapter, "_get_client", None),
             getattr(adapter, "_outbound_blocked", None), getattr(adapter, "_add_reaction", None),
             getattr(adapter, "_remove_reaction", None), getattr(adapter, "_resolve_thread_ts", None))
    if not all(callable(seam) for seam in seams):
        logger.warning(
            "autolinear: Slack adapter internals changed; Hermes answers Leon's messages where he "
            "sends them")
        return
    tasks: set[asyncio.Task] = set()

    @functools.wraps(prefilter)
    async def prefilter_and_start(event, *args, **kwargs):
        accepted = await prefilter(event, *args, **kwargs)
        settings = _settings()
        if accepted is None or settings is None:
            return accepted
        try:
            normalized, team_id, channel_id = accepted
            if isinstance(normalized, dict) and _answers_for_sure(
                    adapter, settings, normalized, str(team_id or "")):
                await _start(
                    adapter, settings, normalized, str(channel_id or ""), str(team_id or ""),
                    tasks)
        except Exception:
            logger.warning("autolinear: could not start early", exc_info=True)
        return accepted

    def prepare_turn(event, msg_event, *, in_issue_channel, quick_delegate) -> None:
        if msg_event is None:
            return
        if (quick_delegate and not msg_event.source.is_bot and msg_event.reply_expected is not False
                and not event.get("_slack_changed_event_ts")):
            msg_event.raw_message[_QUICK_DELEGATE] = {"in_issue_channel": in_issue_channel}
            return
        client_id = event.get("client_msg_id") if isinstance(event, dict) else None
        _add_task_prompt(
            msg_event, in_issue_channel=in_issue_channel,
            agent_report=isinstance(client_id, str) and client_id.startswith(_AGENT_REPORTS))

    async def build_in_place(settings, event, *args, quick_delegate=False, **kwargs):
        msg_event = await build(event, *args, **kwargs)
        if msg_event is not None and not kwargs.get("is_command_text"):
            in_issue_channel = settings is not None and bool(
                settings["issue_channel"].match(msg_event.source.chat_name or ""))
            prepare_turn(
                event, msg_event, in_issue_channel=in_issue_channel, quick_delegate=quick_delegate)
        return msg_event

    @functools.wraps(build)
    async def build_in_issue_channel(event, *args, **kwargs):
        settings = _settings()
        if (settings is None or not isinstance(event, dict)
                or kwargs.get("user_id") != settings["user"] or kwargs.get("is_command_text")
                or not _is_ordinary_message(event)):
            return await build_in_place(settings, event, *args, **kwargs)
        try:
            target = await _move(adapter, settings, event, kwargs, tasks)
        except Exception:
            logger.warning(
                "autolinear: no issue for %s:%s; answering it there",
                kwargs.get("channel_id"), kwargs.get("ts"), exc_info=True)
            target = None
        if target is None:
            return await build_in_place(settings, event, *args, quick_delegate=True, **kwargs)
        moved, moved_kwargs = target
        try:
            msg_event = await build(moved, *args, **moved_kwargs)
        except Exception:
            logger.warning(
                "autolinear: could not build the turn in %s; answering in place",
                moved_kwargs["channel_id"], exc_info=True)
            return await build_in_place(settings, event, *args, quick_delegate=True, **kwargs)
        prepare_turn(event, msg_event, in_issue_channel=True, quick_delegate=True)
        copy_ts, team_id = moved_kwargs["ts"], str(moved_kwargs.get("team_id") or "")
        try:
            # Edits that use the normal model path keep the adapter's reaction lifecycle.
            if not msg_event.raw_message.get(_QUICK_DELEGATE) and adapter._reactions_enabled():
                adapter._track_reacting_message(team_id, copy_ts)
            # An unfurl edit of the copy must not start a second turn.
            adapter._remember_processed_message_ts(copy_ts)
        except Exception:
            logger.warning("autolinear: could not track %s", copy_ts, exc_info=True)
        return msg_event

    @functools.wraps(handle)
    async def handle_message(event, *args, **kwargs):
        raw = event.raw_message
        if not (isinstance(raw, dict) and raw.get(_QUICK_DELEGATE)):
            return await handle(event, *args, **kwargs)
        # Start both immediately. Slack availability should never delay dispatch.
        for operation in (_acknowledge(adapter, event), _delegate(adapter, event)):
            task = asyncio.create_task(operation)
            tasks.add(task)
            task.add_done_callback(tasks.discard)

    adapter._prefilter_inbound = prefilter_and_start
    adapter._build_message_event = build_in_issue_channel
    adapter.handle_message = handle_message
    setattr(adapter, _PATCHED_ATTR, True)
    logger.info(
        "autolinear: direct Codex delegation for Leon's Slack messages%s",
        "" if _settings() else f" (off until {TOKEN_ENV} and {USER_ENV} are set)")


def register(ctx) -> None:
    ctx.register_platform_handler("slack", wire)
