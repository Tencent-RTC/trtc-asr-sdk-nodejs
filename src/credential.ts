/**
 * Credential holds the authentication information for the TRTC-ASR service.
 *
 * Three values are needed:
 * - appId: Tencent Cloud account APPID, from https://console.cloud.tencent.com/cam/capi
 * - sdkAppId: TRTC application ID, from https://console.cloud.tencent.com/trtc/app
 * - secretKey: TRTC SDK secret key, from TRTC console > Application Overview > SDK Key
 *
 * Call {@link Credential.setSite} with {@link SITE_INTL} to use the
 * international cluster. The default is the China site.
 */
import { ASRError, ErrorCode } from "./errors";

export const SITE_CN = "cn";
export const SITE_INTL = "intl";
export const HOST_CN = "asr.cloud-rtc.com";
export const HOST_INTL = "asr-intl.cloud-rtc.com";

/** Return the ASR hostname for site. Empty / cn is domestic; intl is international. */
export function hostForSite(site: string): string {
  const normalized = (site || "").trim().toLowerCase();
  if (normalized === "" || normalized === SITE_CN) {
    return HOST_CN;
  }
  if (normalized === SITE_INTL) {
    return HOST_INTL;
  }
  throw new ASRError(
    ErrorCode.INVALID_PARAM,
    `unsupported site "${site}", want "${SITE_CN}" or "${SITE_INTL}"`,
  );
}

export function wsEndpointForSite(site: string): string {
  return "wss://" + hostForSite(site);
}

export function httpEndpointForSite(site: string): string {
  return "https://" + hostForSite(site);
}

export function resolveWSEndpoint(override: string, site: string): string {
  if (override) {
    return override;
  }
  return wsEndpointForSite(site);
}

export function resolveHTTPEndpoint(override: string, site: string): string {
  if (override) {
    return override;
  }
  return httpEndpointForSite(site);
}

export class Credential {
  /** Tencent Cloud account APPID. Used in URL path. */
  public readonly appId: number;

  /** TRTC application ID. */
  public readonly sdkAppId: number;

  /** SDK secret key. Used to generate UserSig. Never transmitted. */
  public readonly secretKey: string;

  /** TRTC authentication signature (auto-generated if not set). */
  public userSig: string;

  /**
   * ASR cluster. Empty or {@link SITE_CN} is China (asr.cloud-rtc.com);
   * {@link SITE_INTL} is international (asr-intl.cloud-rtc.com).
   */
  public site: string;

  constructor(appId: number, sdkAppId: number, secretKey: string) {
    this.appId = appId;
    this.sdkAppId = sdkAppId;
    this.secretKey = secretKey;
    this.userSig = "";
    this.site = "";
  }

  /** Set a pre-computed UserSig. */
  setUserSig(userSig: string): void {
    this.userSig = userSig;
  }

  /** Select the ASR cluster: SITE_CN (default) or SITE_INTL. */
  setSite(site: string): void {
    this.site = site || "";
  }
}
