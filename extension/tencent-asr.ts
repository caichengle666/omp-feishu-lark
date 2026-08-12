import { createHash, createHmac } from "node:crypto";

const SERVICE = "asr";
const HOST = "asr.tencentcloudapi.com";
const VERSION = "2019-06-14";
const ACTION = "SentenceRecognition";
const MAX_AUDIO_BYTES = 2_250_000;
export const TENCENT_ASR_CONTENT_TYPE = "application/json; charset=utf-8";

export function getTencentAsrCredentials(env: NodeJS.ProcessEnv = process.env) {
  const secretId = env.TENCENTCLOUD_SECRET_ID?.trim();
  const secretKey = env.TENCENTCLOUD_SECRET_KEY?.trim();
  if (!secretId || !secretKey) return undefined;
  return { secretId, secretKey };
}

export function detectTencentVoiceFormat(mimeType?: string, fileName?: string) {
  const mime = mimeType?.toLowerCase().split(";", 1)[0]?.trim();
  if (mime === "audio/wav" || mime === "audio/x-wav" || mime === "audio/wave") return "wav";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/mp4" || mime === "audio/x-m4a") return "m4a";
  if (mime === "audio/aac") return "aac";
  if (mime === "audio/amr") return "amr";
  if (mime === "audio/ogg" || mime === "audio/opus" || mime === "application/ogg") return "ogg-opus";

  const lowerName = fileName?.toLowerCase() || "";
  if (lowerName.endsWith(".wav")) return "wav";
  if (lowerName.endsWith(".mp3")) return "mp3";
  if (lowerName.endsWith(".m4a")) return "m4a";
  if (lowerName.endsWith(".aac")) return "aac";
  if (lowerName.endsWith(".amr")) return "amr";
  return "ogg-opus";
}

export async function transcribeTencentAudio(bytes: Buffer, mimeType?: string, fileName?: string) {
  const credentials = getTencentAsrCredentials();
  if (!credentials) {
    throw new Error("未配置腾讯云语音识别。请设置 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY。");
  }
  if (!bytes.length) throw new Error("语音文件为空");
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error("语音文件超过腾讯云一句话识别的大小限制（约 2.25 MB）");

  const body = JSON.stringify({
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: "16k_zh",
    SourceType: 1,
    VoiceFormat: detectTencentVoiceFormat(mimeType, fileName),
    Data: bytes.toString("base64"),
    DataLen: bytes.length,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = TENCENT_ASR_CONTENT_TYPE;
  const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256(body)].join("\n");
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", timestamp, credentialScope, sha256(canonicalRequest)].join("\n");
  const secretDate = hmac(`TC3${credentials.secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${HOST}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      "X-TC-Action": ACTION,
      "X-TC-Version": VERSION,
      "X-TC-Timestamp": String(timestamp),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as { Response?: { Error?: { Message?: string }; Result?: { Result?: string } } };
  const apiError = result.Response?.Error;
  if (!response.ok || apiError) throw new Error(`腾讯云语音识别失败：${apiError?.Message || `HTTP ${response.status}`}`);
  const text = result.Response?.Result?.Result?.trim();
  if (!text) throw new Error("腾讯云语音识别未返回文字");
  return text;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}
