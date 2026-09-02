/**
 * SDK self-identification carried by every request.
 *
 * Every request (WebSocket handshake and HTTP API calls) reports which SDK
 * language, version and OS platform produced it. Without this, a customer
 * issue can only be traced to an AppID — not to the concrete client build that
 * triggered it, which is what makes cross-version regressions diagnosable.
 *
 * The values travel as URL query parameters rather than headers because a
 * browser-originated WebSocket handshake cannot set custom headers, and the
 * three transports must report identically.
 */

import * as os from "os";

/**
 * Released version of this SDK. Must be kept in sync with the "version" field
 * of package.json.
 *
 * It is duplicated here rather than read from package.json at runtime because
 * the published package only ships "dist" (see package.json "files"), so
 * require("../package.json") resolves to the consumer's own manifest — or
 * nothing at all — once installed.
 */
export const SDK_VERSION = "1.0.0";

/** Identifies the SDK implementation language. */
export const SDK_LANGUAGE = "nodejs";

/**
 * Distinguishes this family of SDKs from the client-side ones. All six
 * language bindings here run server-side, so the value is constant; it exists
 * so server-side telemetry can bucket traffic the same way it does for the
 * mobile/desktop client SDKs.
 */
export const SDK_TYPE = "server";

/**
 * Reports the OS platform the SDK is running on, normalized to the vocabulary
 * the service expects: windows, linux, mac, android, ios. Any other
 * os.platform() value is reported verbatim so a new platform shows up in
 * telemetry instead of being silently misattributed.
 */
export function sdkPlatform(): string {
  switch (os.platform()) {
    case "darwin":
      return "mac";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "android":
      return "android";
    default:
      return os.platform();
  }
}

/**
 * Returns the SDK identification parameters shared by every transport.
 */
export function sdkReportParams(): Record<string, string> {
  return {
    platform: sdkPlatform(),
    sdk_lang: SDK_LANGUAGE,
    sdk_type: SDK_TYPE,
    version: SDK_VERSION,
  };
}

/**
 * Returns the SDK identification parameters as an encoded query fragment (no
 * leading "&"), for the transports that build their URL by string
 * concatenation.
 */
export function sdkReportQuery(): string {
  const params = sdkReportParams();
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
}
