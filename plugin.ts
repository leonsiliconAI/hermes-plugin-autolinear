import { fileURLToPath } from "node:url";

/** Hermes plugin name, as listed in `plugins.enabled`. */
export const pluginName = "autolinear";

/** Directory to copy (without `__tests__/`) to `$HERMES_HOME/plugins/autolinear/`. */
export const pluginDirectory = fileURLToPath(new URL(".", import.meta.url));

/** Files that make up the deployed plugin. */
export const pluginFiles = [
  "plugin.yaml",
  "__init__.py",
  "pyproject.toml",
  "_pythonmonkey.py",
  "policy.cjs",
] as const;

/**
 * `.env` settings. The token (autolinear's `AUTOLINEAR_TOKEN`) and Leon's Slack user ID turn it
 * on; the rest are optional.
 */
export const tokenEnv = "AUTOLINEAR_TOKEN";
export const userEnv = "AUTOLINEAR_USER_ID";
export const urlEnv = "AUTOLINEAR_URL";
export const channelPrefixEnv = "AUTOLINEAR_CHANNEL_PREFIX";
export const skipChannelsEnv = "AUTOLINEAR_SKIP_CHANNELS";

/** autolinear's intake endpoint, unless `AUTOLINEAR_URL` says otherwise. */
export const defaultUrl = "https://autolinear.leonsilicon.ai/intake";
