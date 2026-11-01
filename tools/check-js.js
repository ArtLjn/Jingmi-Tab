/* 扩展没有构建步骤，统一检查生产脚本、开发工具和回归测试的语法。 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['sw.js'];
for (const dir of ['js', 'tests', 'tools']) {
  for (const name of fs.readdirSync(path.join(root, dir))) if (name.endsWith('.js')) files.push(path.join(dir, name));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('通过 ' + files.length + ' 个 JavaScript 文件的语法检查');
