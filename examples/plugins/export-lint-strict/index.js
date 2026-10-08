// 由 scripts/build-plugin-sdk.mjs 从 src/index.ts 生成，勿手改。
// editor/sdk/index.ts
function definePlugin(p) {
  return p;
}

// examples/plugins/export-lint-strict/src/index.ts
var SAFE = /^[A-Za-z0-9_./-]+$/;
var index_default = definePlugin({
  name: "export-lint-strict",
  inject: ["export.rules"],
  apply(ctx, host) {
    const maxMB = host.settings?.get("maxFileMB", 64) ?? 64;
    const rule = {
      id: "lint-strict",
      stage: "loose",
      order: 200,
      check(x) {
        for (const f of x.files) {
          if (!SAFE.test(f.path)) x.diag("error", "unsafe-name", `文件名含空格或非 ASCII 字符：${f.path}`, f.path);
          if (f.data.byteLength > maxMB * 1024 * 1024) {
            x.diag("warn", "big-file", `单文件超过 ${maxMB} MB（${(f.data.byteLength / 1048576).toFixed(1)} MB）：${f.path}`, f.path);
          }
        }
        if (x.doc.scene && !x.files.some((f) => /^preview\.(jpg|png|gif)$/i.test(f.path))) {
          x.diag("warn", "no-preview", "没有封面 preview.jpg（创意工坊列表会显示空白）");
        }
      }
    };
    ctx.contribute("export.rules", rule);
  }
});
export {
  index_default as default
};
