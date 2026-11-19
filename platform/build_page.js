// Inlines the recorded runs, the agent core and the runner into platform/index.html (one self-contained file).
//   node platform/build_page.js
const fs = require('fs'), p = f => __dirname + '/' + f;
const data = fs.readFileSync(p('data/scenarios.json'), 'utf8').replace(/</g, '\\u003c');
const core = fs.readFileSync(p('../planner/core.js'), 'utf8'), runner = fs.readFileSync(p('../planner/runner.js'), 'utf8');
for (const [n, s] of [['core', core], ['runner', runner]]) if (/<\/script/i.test(s)) throw new Error(n + ' contains </script');
const html = fs.readFileSync(p('src.html'), 'utf8').replace('/*__DATA__*/', () => data).replace('/*__CORE__*/', () => core).replace('/*__RUNNER__*/', () => runner);
fs.writeFileSync(p('artifact.html'), html);   // body only: the claude.ai artifact host adds the document skeleton
fs.writeFileSync(p('index.html'), '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<style>body{margin:0}[hidden]{display:none!important}</style>\n</head>\n<body>\n' + html + '\n</body>\n</html>\n');
console.log('wrote platform/index.html', (html.length / 1024).toFixed(0), 'KB');
