# @-/com.leonsilicon.hermes.plugins.autolinear

Hermes plugin that gives each of Leon's Slack messages its own Linear issue and channel the moment it arrives, through [autolinear](https://github.com/leonsilicon/leonsilicon.ai/blob/main/apps/autolinear/README.md), and hands Leon's request to a Codex session.

## Why

Every message Leon sends to Hermes outside an issue channel gets a new Linear issue in Awaiting Init and its own Slack channel. AutoLinear edits his message to link the channel where Hermes posts the Codex session link and follows up on the work.

## What happens

1. Leon writes to Hermes outside an issue channel: a DM, `#general`, a project channel, a reply under a `#feed-` post.
2. AutoLinear's Slack app usually starts intake before Hermes receives the message. Once the message reaches Hermes and passes dedup and the bot check, the plugin calls `POST /intake` in the background to get the running or finished intake. AutoLinear creates the issue, opens its `leon-<n>-<first words>` channel, and posts a copy of the message there as Leon. Once Slack confirms the copy, AutoLinear replaces the original message with the channel link.
3. Hermes adds 👀 to acknowledge the request. It keeps the message, Slack thread context and file links when AutoLinear moves the request. In an existing issue channel, the handoff uses Leon's conversation there.
4. The Slack gateway dispatches directly to Silicon Dot through the [Beeper inbox](https://github.com/leonsilicon/leonsilicon.ai/blob/main/packages/ai/leonsilicon/services/beeper-inbox/README.md#agent-tasks-2026-11-21). Dot opens or resumes the Codex session and returns its private ChatGPT URL. The gateway matches Dot's reply to Leon's request and posts **Open Codex session** as soon as it gets the link. The acknowledgement, dispatch and link run without a Hermes model turn. [slack-flat-replies](https://github.com/leonsilicon/leonsilicon.ai/blob/main/apps/hermes-plugin-slack-flat-replies/README.md) keeps top-level requests and threaded requests in their respective conversations.
5. slack22linear sees 👀 in the issue channel and moves the issue to Executing. Codex reports through Slack Puppet in the task thread, and Hermes coordinates follow-up in the same conversation. It can handle routine worker reports silently and sends an [Autolinear command](https://github.com/leonsilicon/leonsilicon.ai/blob/main/packages/ai/leonsilicon/services/slack22linear/README.md#autolinears-commands) when the report calls for a status change.

The gateway delegates fresh requests from Leon. Commands, edits, bot messages and delegated-agent reports continue through the adapter's usual path. The handoff preserves the original Linear title and Slack channel name and directs separate work to a linked issue. Model turns still receive the delegation and status instructions when appropriate, including Autolinear's raw bot mention for status commands.

## Which messages

A message moves when Hermes answers it, Leon (`AUTOLINEAR_USER_ID`) wrote it, it isn't a command (`/new`, `!stop`) or a reaction-triggered turn, and it isn't in an issue channel (`leon-<number>` or `leon-<number>-…`) or in `AUTOLINEAR_SKIP_CHANNELS`. Otherwise Hermes answers where it is, as before.

The early start, before Hermes's own gates have run (`_prefilter_inbound`), is only for messages Hermes always answers: also no `/` or `!` at the start and no mention of anyone but Hermes. Anything else that Hermes ends up answering starts when its turn is built (`_build_message_event`, which runs only after the gates), a little later. An early start whose message Hermes then doesn't answer is logged (`made LEON-… but Hermes didn't answer that message`).

A thread reply's thread goes along: Hermes keeps the thread history it read, and slack22linear quotes the thread's first message in the issue. A message in a project's channel files the issue in that project.

## Failure

When AutoLinear declines intake, fails or takes longer than 25 seconds, channel requests can still hand off from their original conversation. A DM needs an issue channel for Codex's Slack reports. The gateway reports a failed handoff or a missing session link in the request's conversation. It waits up to three minutes for Dot's link. AutoLinear retries intake once for a network error or 5xx and deduplicates it by Slack message. Beeper deduplicates sends with `autolinear:slack:<original-channel>:<message-ts>`. Dot's session-link reply keeps the slash in the Slack reference (`slack:<channel>/<ts>`).

The copy carries slack-as-leon's `client_msg_id` marker, so [slack-as-leon-guard](https://github.com/leonsilicon/leonsilicon.ai/blob/main/apps/hermes-plugin-slack-as-leon-guard/README.md) drops its live event, and Hermes doesn't answer the message twice. Keep that plugin enabled; this one logs a warning when it isn't. The copy's ts is also claimed, so its unfurl edits start no turn. autolinear's edit of Leon's message starts none either: Hermes claimed that message's ts before its turn was built.

## Settings

In `$HERMES_HOME/.env` (the dashboard's Keys page), from the `#hermes` items of the root [`.env.schema`](https://github.com/leonsilicon/leonsilicon.ai/blob/main/.env.schema). Without the first two, the plugin is off.

| Key                         | Value                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTOLINEAR_TOKEN`          | autolinear's `AUTOLINEAR_TOKEN`                                                                                                                                                                                    |
| `AUTOLINEAR_USER_ID`        | Leon's Slack user ID                                                                                                                                                                                               |
| `AUTOLINEAR_URL`            | Optional; default `https://autolinear.leonsilicon.ai/intake`                                                                                                                                                       |
| `AUTOLINEAR_CHANNEL_PREFIX` | Optional; default `leon`, slack22linear's channel prefix                                                                                                                                                           |
| `AUTOLINEAR_SKIP_CHANNELS`  | Optional; comma-separated channel IDs whose messages Hermes answers there                                                                                                                                          |
| `AUTOLINEAR_BOT_USER_ID`    | Optional; Autolinear's bot user, whose mention starts Hermes's command line. Without it, the prompt asks for a plain `@Autolinear`. Also add it to `SLACK_ALLOWED_USERS`, or Hermes ignores Autolinear's reminders |

They're read on every message, so removing the token turns the plugin off once Hermes's env reloads.

## Install

```sh
hermes plugins install leonsiliconAI/hermes-plugin-autolinear --enable
```

See [migration steps](https://github.com/leonsilicon/leonsilicon.ai/blob/main/DEVELOPMENT.md#hermes-plugin-mirrors) for an existing install. Restart the gateway. The gateway log shows `autolinear: direct Codex delegation for Leon's Slack messages`. It uses the [Beeper inbox installation](https://github.com/leonsilicon/leonsilicon.ai/blob/main/apps/beeper-inbox/README.md) at `$BEEPER_INBOX_HOME` (default `$HERMES_HOME/beeper-inbox`).

The gateway finds the exact direct chat named `Silicon Dot` on Beeper's ChatGPT network. Set `AUTOLINEAR_DOT_ROOM_ID` in Hermes's environment if the chat has a different name or multiple rooms match.

Hermes Cloud's `SOUL.md`, `issue-execution-sweep`, and `leon-messaging-voice` should require delegation for every task and use the same status rule for Slack replies, including the exception for delegated-agent reports. A sweep originating in Linear can use a Linear comment with Leon's mention to trigger the handoff.

## Test

The tests drive the real Slack adapter, so they need a Hermes checkout's environment. Hermes Cloud ran v0.23.2 when this was written:

```sh
git -C ~/.hermes/hermes-agent worktree add --detach /tmp/hermes-v0.23.2 v0.23.2
cd /tmp/hermes-v0.23.2 && UV_PROJECT_ENVIRONMENT=/tmp/hermes-venv uv sync --frozen --extra slack
VIRTUAL_ENV=/tmp/hermes-venv uv pip install pytest pytest-asyncio
cd - && HERMES_HOME=$(mktemp -d) PYTHONPATH=/tmp/hermes-v0.23.2 /tmp/hermes-venv/bin/python -m pytest -q -p no:cacheprovider __tests__
```

They drive the real Slack adapter with a simulated Beeper inbox and check that fresh requests dispatch once, bypass the model turn, and post a matching session link in the right conversation.
