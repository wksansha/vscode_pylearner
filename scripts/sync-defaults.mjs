// 打包前同步：把 src/constants.ts 的 DEFAULT_TEACHER_URL 写入 package.json 的设置默认值。
// 单一事实源 = src/constants.ts（换部署环境只改它）；package.json 的 default 由本脚本自动对齐，
// 杜绝「设置界面显示 A、运行时兜底 B」的两处漂移问题。
import { readFileSync, writeFileSync } from "node:fs";

const constants = readFileSync("src/constants.ts", "utf8");
const m = constants.match(/DEFAULT_TEACHER_URL\s*=\s*"([^"]+)"/);
if (!m) {
  console.error("[sync-defaults] src/constants.ts 中未找到 DEFAULT_TEACHER_URL");
  process.exit(1);
}
const url = m[1];

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const prop = pkg.contributes?.configuration?.properties?.["pylearner.teacher.url"];
if (!prop) {
  console.error("[sync-defaults] package.json 中未找到 pylearner.teacher.url 配置项");
  process.exit(1);
}

if (prop.default !== url) {
  prop.default = url;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`[sync-defaults] pylearner.teacher.url default → ${url}（已同步）`);
} else {
  console.log(`[sync-defaults] pylearner.teacher.url default 已是 ${url}（无需同步）`);
}
