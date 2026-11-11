const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
for(const name of fs.readdirSync(root).filter((x)=>x.endsWith('.js')))cp.execFileSync(process.execPath,['--check',path.join(root,name)],{stdio:'inherit'});
for(const name of fs.readdirSync(root).filter(x=>x.endsWith('.js'))) {
 for(const match of fs.readFileSync(path.join(root,name),'utf8').matchAll(/importScripts\(([^)]*)\)/g)) {
  for(const script of match[1].matchAll(/['"]([^'"]+)['"]/g))assert(fs.existsSync(path.join(root,script[1])),`${name}: ${script[1]}`);
 }
}
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
for(const name of [manifest.background.service_worker,manifest.side_panel.default_path,...manifest.content_scripts.flatMap((s)=>s.js),...Object.values(manifest.icons),...Object.values(manifest.action.default_icon),'icons/alert.png'])assert(fs.existsSync(path.join(root,name)),name);
for(const html of ['popup.html','offscreen.html']) {
 const s=fs.readFileSync(path.join(root,html),'utf8');
 for(const match of s.matchAll(/(?:src|href)="([^"#]+)"/g))assert(fs.existsSync(path.join(root,match[1])),match[1]);
 const ids=[...s.matchAll(/\bid="([^"]+)"/g)].map((m)=>m[1]);assert.equal(new Set(ids).size,ids.length,'duplicate DOM IDs');
}
const html=fs.readFileSync(path.join(root,'popup.html'),'utf8'),js=fs.readFileSync(path.join(root,'popup.js'),'utf8');
for(const match of js.matchAll(/\$\('#([a-zA-Z]+)'\)/g))assert(html.includes(`id="${match[1]}"`),match[1]);
const controls=fs.readFileSync(path.join(root,'popup-controls.js'),'utf8');
for(const match of controls.matchAll(/\$\('([a-zA-Z]+)'\)/g))assert(html.includes(`id="${match[1]}"`),match[1]);
for(const id of ['start','end'])for(const suffix of ['Button','Control','Error','Date','Time','Year','Month','Day','Hour','Minute','Second'])assert(html.includes(`id="${id}${suffix}"`));
assert.equal(manifest.version,JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version);
console.log('全部脚本语法、manifest 资源、HTML 引用及界面 ID 检查通过');
