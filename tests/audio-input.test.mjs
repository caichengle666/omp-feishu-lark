import assert from "node:assert/strict";
import test from "node:test";
import { parseMessageInput } from "../extension/messages.ts";
import { detectTencentVoiceFormat, getTencentAsrCredentials, transcribeTencentAudio, TENCENT_ASR_CONTENT_TYPE } from "../extension/tencent-asr.ts";

test("parses Feishu audio messages as audio attachments", () => {
  const parsed = parseMessageInput({
    msgType: "audio",
    content: JSON.stringify({ file_key: "file_audio_123" }),
  });

  assert.deepEqual(parsed, {
    text: "",
    attachments: [{ kind: "audio", fileKey: "file_audio_123", fileName: "audio.ogg" }],
  });
});

test("maps Feishu audio formats to Tencent ASR formats", () => {
  assert.equal(detectTencentVoiceFormat("audio/ogg"), "ogg-opus");
  assert.equal(detectTencentVoiceFormat("audio/mpeg"), "mp3");
  assert.equal(detectTencentVoiceFormat(undefined, "voice.wav"), "wav");
});

test("uses Tencent ASR JSON content type", () => {
  assert.equal(TENCENT_ASR_CONTENT_TYPE, "application/json; charset=utf-8");
});

test("keeps Tencent credentials opt-in", async () => {
  assert.equal(getTencentAsrCredentials({}), undefined);
  await assert.rejects(
    () => transcribeTencentAudio(Buffer.from("audio"), "audio/ogg"),
    /未配置腾讯云语音识别/,
  );
});
