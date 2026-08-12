import assert from "node:assert/strict";
import test from "node:test";
import { showAuthorizationQRCode } from "../extension/setup.ts";

test("renders the complete authorization QR code in a fullscreen OMP overlay", async () => {
  let component;
  let options;
  let done;
  const ctx = {
    ui: {
      custom(factory, customOptions) {
        options = customOptions;
        return new Promise((resolve) => {
          done = resolve;
          component = factory({}, {}, {}, resolve);
        });
      },
    },
  };

  const close = showAuthorizationQRCode(
    ctx,
    "https://open.feishu.cn/page/launcher?user_code=TEST-CODE&from=sdk&source=node-sdk%2Fpi-feishu-extension&tp=sdk",
  );

  assert.equal(options.overlay, true);
  assert.equal(options.overlayOptions.fullscreen, true);
  assert.equal(options.overlayOptions.maxHeight, "100%");
  const lines = component.render(80);
  assert.ok(lines.length > 10, "QR code must not pass through OMP's 10-line widget limit");
  assert.ok(lines.every((line) => line.length <= 80), "QR code must fit the overlay width");

  close();
  assert.equal(typeof done, "function");
});
