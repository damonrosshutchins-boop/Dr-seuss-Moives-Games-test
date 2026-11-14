import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { createBrotliDecompress } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";

const require=createRequire(import.meta.url);
const out="dist";
const pkgDir=pkg=>path.dirname(require.resolve(pkg));
async function exists(file){try{await fs.access(file);return true;}catch{return false;}}
async function findFile(root,name,depth=0){
 if(depth>5||!await exists(root))return null;
 const entries=await fs.readdir(root,{withFileTypes:true});
 for(const entry of entries){
  if(entry.isFile()&&entry.name===name)return path.join(root,entry.name);
 }
 for(const entry of entries){
  if(entry.isDirectory()&&entry.name!=="node_modules"){
   const found=await findFile(path.join(root,entry.name),name,depth+1);
   if(found)return found;
  }
 }
 return null;
}
async function copyRuntime(name,root,entry){
 const actual=await findFile(root,entry);
 if(!actual)throw new Error(name+": missing "+entry+" in "+root);
 const source=path.dirname(actual);
 await fs.cp(source,path.join(out,name),{recursive:true});
 console.log("Copied "+name+" from "+source);
}
await fs.rm(out,{recursive:true,force:true});
await fs.mkdir(out,{recursive:true});
for(const file of ["index.html","proxy-client.js","sw.js","calls.js","calls.css"])
 await fs.copyFile(file,path.join(out,file));
// This local setup screen does not ship Nintendo disc images or emulator binaries.
await fs.mkdir(path.join(out,"games","smsrip"),{recursive:true});
await fs.copyFile(path.join("games","smsrip","index.html"),path.join(out,"games","smsrip","index.html"));
// Ghost of Sparta is proxied only by Render's fixed-origin route.
// Publish a same-site launcher, never a direct iframe of the Surge source.
await fs.mkdir(path.join(out,"games","gow-sparta"),{recursive:true});
await fs.copyFile(path.join("games","gow-sparta","index.html"),path.join(out,"games","gow-sparta","index.html"));
// Two fixed-route Minecraft 1.8 launchers; game files are served by Render.
for(const slug of ["minecraft-18-wrust","minecraft-18-mods"]){
  const dir=path.join(out,"games",slug);
  await fs.mkdir(dir,{recursive:true});
  await fs.copyFile(path.join("games",slug,"index.html"),path.join(dir,"index.html"));
}
// Copy the small Horizon loader and its strictly scoped service worker.
// A later owner-committed standalone HTML is published automatically.
await fs.mkdir(path.join(out,"games","horizon"),{recursive:true});
for(const file of ["index.html","sw.js"])
  await fs.copyFile(path.join("games","horizon",file),path.join(out,"games","horizon",file));
// Reassemble the exact user-provided standalone HTML at build time.
// GitHub's API ingests 12 small text chunks instead of a 45.6 MB file.
// Only the completed playable HTML enters the public Pages artifact.
const horizonParts=[];
for(let n=0;n<12;n++){
  const name="part"+String(n).padStart(2,"0")+".txt";
  horizonParts.push(await fs.readFile(path.join("games","horizon","parts",name)));
}
const horizonInput=Buffer.concat(horizonParts);
const expectedHorizonHash="d54274c77ed28a70b85f82b16193cc756a4baa7ca01fceea1e0707358c512d7d";
const actualHorizonHash=(await import("node:crypto")).createHash("sha256").update(horizonInput).digest("hex");
if(actualHorizonHash!==expectedHorizonHash)
  throw Error("Horizon standalone file integrity mismatch: "+actualHorizonHash);
let horizonHTML=horizonInput.toString("utf8");
// Preserve the self-contained WASM and prepared resources, while restricting
// optional audio fetches to the existing pinned Render asset routes.
// Default quick launch skips the 355 MB audio archive.
for(const [from,to] of [
 ["const SOUND_CDN = \x60https://cdn.jsdelivr.net/gh/AlexBoops/mc-rust-onweb@\x24{SOUND_COMMIT}/\x60;",
  'const SOUND_CDN = "https://seuss-cinema-arcade.onrender.com/approved-games/horizon/";'],
 ['const SOUND_FALLBACK = "https://alexboops.github.io/mc-rust-onweb/";',
  'const SOUND_FALLBACK = "https://seuss-cinema-arcade.onrender.com/approved-games/horizon/";'],
 ["const files = await downloadSoundArchive();",
  'const files = new URLSearchParams(location.search).get("audio") === "1" ? await downloadSoundArchive() : new Map();']
]){
 if(!horizonHTML.includes(from))throw Error("Horizon entrypoint unexpectedly changed: "+from.slice(0,55));
 horizonHTML=horizonHTML.replace(from,to);
}
await fs.writeFile(path.join(out,"games","horizon","play.html"),horizonHTML);
console.log("Published verified 45.6 MB Horizon self-contained game for automatic play.");


 // These games use locally hosted entry pages. Their network game assets are
 // fetched ONLY from pinned, path-restricted Render proxy routes.
for(const slug of ["balatro","cheese"]){
  await fs.mkdir(path.join(out,"games",slug),{recursive:true});
  await fs.copyFile(path.join("games",slug,"index.html"),path.join(out,"games",slug,"index.html"));
}



// Publish the four imported game launchers on GitHub Pages. The browser
// stays inside the arcade; large game binaries are fetched from pinned
// approved Render routes rather than copied into the Pages artifact.
const importedGames=["plants-vs-zombies-ds","mario-kart-64","1v1-lol","fnae","zelda-oot","centipede-arcade","tung-sahur-obby","run-2","uwu-client"];
for(const slug of importedGames){
  const source=path.join("games",slug,"index.html");
  const destination=path.join(out,"games",slug,"index.html");
  if(!await exists(source))throw Error("Missing imported game launcher: "+source);
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.copyFile(source,destination);
  const contents=await fs.readFile(destination,"utf8");
  if(!contents.trim()||!/<(?:html|head|body)\b/i.test(contents))
    throw Error("Invalid imported game launcher: "+destination);
  console.log("Published imported launcher: "+slug);
}

await copyRuntime("scram",scramjetPath,"scramjet.js");
await copyRuntime("controller",pkgDir("@mercuryworkshop/scramjet-controller"),"controller.api.js");
await copyRuntime("utils",pkgDir("@mercuryworkshop/scramjet-utils"),"scramjet-utils.js");
await copyRuntime("libcurl",pkgDir("@mercuryworkshop/libcurl-transport"),"index.mjs");
for(const file of ["scram/scramjet.js","scram/scramjet.wasm","controller/controller.sw.js","controller/controller.api.js","controller/controller.inject.js","utils/scramjet-utils.js","libcurl/index.mjs"]){
 const target=path.join(out,file);
 if(!await exists(target))throw new Error("Pages build missing mandatory browser asset: "+file);
 const size=(await fs.stat(target)).size;
 if(size===0)throw new Error("Pages asset is empty: "+file);
 console.log("Verified "+file+" ("+size+" bytes)");
}
// Bundle the requested Meowdoku Godot web port under our own Pages path.
// Pin the upstream commit for repeatable builds and include the game data
// so it does not depend on the upstream GitHub Pages hosting at runtime.
const meowCommit = "941ed3caf7983d0fa6350ad3dc928c434b2f3b4b";
const meowTemp = await fs.mkdtemp(path.join(os.tmpdir(), "meowdoku-"));
try {
  execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout",
    "https://github.com/c00lkiddtech/md-.git", meowTemp],
    {stdio:"inherit",timeout:120000});
  execFileSync("git", ["-C", meowTemp, "checkout", meowCommit],
    {stdio:"inherit",timeout:120000});
  const gameOut=path.join(out,"games","meowdoku");
  await fs.mkdir(gameOut,{recursive:true});
  for(const entry of await fs.readdir(meowTemp,{withFileTypes:true})){
    if(entry.name===".git"||entry.name===".gitattributes")continue;
    await fs.cp(path.join(meowTemp,entry.name),path.join(gameOut,entry.name),{recursive:true});
  }
  for(const file of ["index.html","index.js","loader.js","data"]){
    if(!await exists(path.join(gameOut,file)))throw new Error("Meowdoku local bundle missing "+file);
  }
  console.log("Bundled Meowdoku assets into dist/games/meowdoku/");
} finally { await fs.rm(meowTemp,{recursive:true,force:true}); }
// Super Mario 64 JavaScript upstream source includes GPL-3.0 license.
// Bundle its browser entrypoint, game files and license as a separate local game.
const sm64Commit = "f9a56855403dee1ea37a3fd2ad24e0217de5ed17";
const sm64Temp = await fs.mkdtemp(path.join(os.tmpdir(), "sm64-"));
try {
  execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout",
    "https://github.com/ripjaw1219/super-mario-64-javascript.git", sm64Temp],
    {stdio:"inherit",timeout:120000});
  execFileSync("git", ["-C", sm64Temp, "checkout", sm64Commit],
    {stdio:"inherit",timeout:120000});
  const target=path.join(out,"games","sm64");
  await fs.mkdir(target,{recursive:true});
  for(const entry of await fs.readdir(sm64Temp,{withFileTypes:true})){
    if(entry.name===".git")continue;
    await fs.cp(path.join(sm64Temp,entry.name),path.join(target,entry.name),{recursive:true});
  }
  for(const file of ["start.html","game/sm64.js","game/sm64.wasm","LICENSE"]){
    if(!await exists(path.join(target,file)))throw new Error("Local SM64 bundle missing "+file);
  }
  console.log("Bundled GPL-3.0 SM64 JavaScript project at dist/games/sm64/");
} finally { await fs.rm(sm64Temp,{recursive:true,force:true}); }
// Bundle the FISH Unity build from the user's authorized fork.
const fishTemp = await fs.mkdtemp(path.join(os.tmpdir(), "fish-"));
try {
  execFileSync("git", ["clone","--depth=1","--filter=blob:none",
    "https://github.com/damonrosshutchins-boop/fish.git",fishTemp],
    {stdio:"inherit",timeout:180000});
  const gameOut=path.join(out,"games","fish");
  await fs.mkdir(gameOut,{recursive:true});
  for(const entry of await fs.readdir(fishTemp,{withFileTypes:true})){
    if(entry.name===".git")continue;
    await fs.cp(path.join(fishTemp,entry.name),path.join(gameOut,entry.name),{recursive:true});
  }
  const htmlPath=path.join(gameOut,"index.html");
  let gameHtml=await fs.readFile(htmlPath,"utf8");
  gameHtml=gameHtml.replace(/<base\s+href="https:\/\/cdn\.jsdelivr\.net\/gh\/web-ports\/fish@main\/"\s*>/i,"");
  await fs.writeFile(htmlPath,gameHtml);
  for(const file of ["index.html","Build/FISH.loader.js","Build/FISH.data.part1","Build/FISH.wasm.part1"])
    if(!await exists(path.join(gameOut,file)))throw new Error("FISH local bundle missing "+file);
  console.log("Bundled FISH from authorized fork into dist/games/fish/");
} finally { await fs.rm(fishTemp,{recursive:true,force:true}); }
// FNASH2 is distributed as seven parts of one compressed Unity data stream.
// Restore uncompressed files at build time because Pages cannot set Content-Encoding: br.
const fnTemp=await fs.mkdtemp(path.join(os.tmpdir(),"fnash2-"));
try {
  execFileSync("git",["clone","--depth=1","--filter=blob:none",
    "https://github.com/damonrosshutchins-boop/FNASH2.git",fnTemp],
    {stdio:"inherit",timeout:180000});
  const gameOut=path.join(out,"games","fnash2");
  await fs.mkdir(gameOut,{recursive:true});
  for(const entry of await fs.readdir(fnTemp,{withFileTypes:true})){
    if(entry.name===".git"||entry.name==="single.html")continue;
    await fs.cp(path.join(fnTemp,entry.name),path.join(gameOut,entry.name),{recursive:true});
  }
  const dir=path.join(gameOut,"Build");
  const names=Array.from({length:7},(_,i)=>path.join(dir,"FNASH2.data.br.part"+(i+1)));
  for(const file of names)if(!await exists(file))throw new Error("FNASH2 missing "+file);
  async function* compressedChunks(parts){
    for(const file of parts)for await(const chunk of createReadStream(file))yield chunk;
  }
  await pipeline(Readable.from(compressedChunks(names)),createBrotliDecompress(),
    createWriteStream(path.join(dir,"FNASH2.data")));
  for(const stem of ["FNASH2.framework.js","FNASH2.wasm"]){
    await pipeline(createReadStream(path.join(dir,stem+".br")),createBrotliDecompress(),
      createWriteStream(path.join(dir,stem)));
  }
  let gameHtml=await fs.readFile(path.join(gameOut,"index.html"),"utf8");
  gameHtml=gameHtml.replaceAll("FNASH2.data.br","FNASH2.data")
    .replaceAll("FNASH2.framework.js.br","FNASH2.framework.js")
    .replaceAll("FNASH2.wasm.br","FNASH2.wasm");
  await fs.writeFile(path.join(gameOut,"index.html"),gameHtml);
  for(const file of names)await fs.rm(file);
  await fs.rm(path.join(dir,"FNASH2.framework.js.br"));
  await fs.rm(path.join(dir,"FNASH2.wasm.br"));
  console.log("Bundled decompressed FNASH2 Unity files at dist/games/fnash2/");
} finally {await fs.rm(fnTemp,{recursive:true,force:true});}
// Hollow Knight is ~1 GB of split Unity assets. Keep the entry page local,
// but fetch the user-authorized fork's existing chunks from a pinned CDN URL.
// The split files are not compressed; decompressing would not reduce the size.
const hollowCommit = "a73f4f8991b54ec844dc90995cd9ee606d8e7810";
const hollowSource = "https://raw.githubusercontent.com/damonrosshutchins-boop/Hollow-Knight-Webport/" + hollowCommit + "/index.html";
const hollowResponse = await fetch(hollowSource);
if(!hollowResponse.ok)throw new Error("Failed to fetch Hollow Knight launcher: "+hollowResponse.status);
let hollowHtml = await hollowResponse.text();
hollowHtml = hollowHtml.replace(
  '<base href="https://raw.githack.com/Stratus-Games/Hollow-Knight-Webport/main/">',
  '<base href="https://cdn.jsdelivr.net/gh/damonrosshutchins-boop/Hollow-Knight-Webport@'+hollowCommit+'/">'
);
if(!hollowHtml.includes("cdn.jsdelivr.net/gh/damonrosshutchins-boop/Hollow-Knight-Webport"))
  throw new Error("Hollow Knight upstream launcher base URL changed");
const hollowOut=path.join(out,"games","hollow-knight");
await fs.mkdir(hollowOut,{recursive:true});
await fs.writeFile(path.join(hollowOut,"index.html"),hollowHtml);
console.log("Bundled Hollow Knight launcher; large split assets remain hosted on user's fork via CDN.");
// Lightweight in-site launchers for oversized browser builds. Their
// Unity data/chunks remain on the original publishers' hosts, not on Pages.
async function addRemoteAssetLauncher(name, ownerRepo, revision, transforms) {
  const source="https://raw.githubusercontent.com/"+ownerRepo+"/"+revision+"/index.html";
  const response=await fetch(source);
  if(!response.ok)throw new Error(name+" launcher fetch failed: "+response.status);
  let html=await response.text();
  for(const [find,replacement] of transforms){
    if(!html.includes(find))throw new Error(name+" launcher HTML changed: "+find);
    html=html.replaceAll(find,replacement);
  }
  const folder=path.join(out,"games",name);
  await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,"index.html"),html);
  console.log("Built "+name+" launcher; bulk game assets are remotely hosted.");
}
await addRemoteAssetLauncher("granny3","AlexBoops/granny3rip","a8e59b3d10ff96d54881903a83a4fc9fcc02bf28",[
  ['<base href="./">','<base href="https://cdn.jsdelivr.net/gh/AlexBoops/granny3rip@a8e59b3d10ff96d54881903a83a4fc9fcc02bf28/">']
]);
await addRemoteAssetLauncher("silksong","web-ports/hollow-knight-silksong","bcbe014765f2f6ca4b1d82ac25755a0299a600ab",[
  ['https://cdn.jsdelivr.net/gh/web-ports/hollow-knight-silksong@master/','https://cdn.jsdelivr.net/gh/web-ports/hollow-knight-silksong@bcbe014765f2f6ca4b1d82ac25755a0299a600ab/'],
  ['https://cdn.jsdelivr.net/gh/web-ports/hollow-knight-silksong@latest/','https://cdn.jsdelivr.net/gh/web-ports/hollow-knight-silksong@bcbe014765f2f6ca4b1d82ac25755a0299a600ab/']
]);
// Half-Life 2 remains source-hosted in an iframe, with no local game asset copy.
for(const [slug,title,source] of [
  ["half-life-2","Half-Life 2 Web Port","https://alexboops.github.io/half-life-2-port/"]
]){
  const folder=path.join(out,"games",slug);
  await fs.mkdir(folder,{recursive:true});
  const page='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title>'+
    '<style>html,body{margin:0;height:100%;background:#101522;color:white;font:14px system-ui}iframe{width:100%;height:100%;border:0;display:block}#note{position:absolute;top:0;left:0;right:0;padding:9px;background:#182033d9;pointer-events:none}iframe:not([src]){display:none}</style>'+
    '<div id="note">Source-hosted game running inside the arcade. Browser restrictions may prevent some games from loading.</div>'+
    '<iframe title="'+title+'" referrerpolicy="no-referrer" allow="autoplay; gamepad" src="'+source+'"></iframe></html>';
  await fs.writeFile(path.join(folder,"index.html"),page);
}
// Portal 1 checks crossOriginIsolated BEFORE downloading assets, and its
// coi-serviceworker can isolate only the top-level source page, not a frame
// nested in a non-isolated arcade. Its game data is ~1.6 GB, so don't copy it
// to Pages or keep an iframe that silently fails at "INITIALIZE SYSTEM".
// Redirect in the SAME tab. Browser Back returns to the arcade.
{
  const folder=path.join(out,"games","portal-1");
  await fs.mkdir(folder,{recursive:true});
  const portalLanding='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Portal 1 · Launch</title>'+
    '<style>:root{color-scheme:dark}body{background:#0d141d;color:#e8f5ff;font:15px/1.6 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;margin:0;padding:20px}main{max-width:650px;background:#17283d;border:1px solid #4b758b;border-radius:15px;padding:26px}a{color:#8ce2ff}a:focus-visible{outline:3px solid #ffde9a;outline-offset:3px}</style>'+
    '<main><h1>Launching Portal 1</h1><p>This game requires cross-origin isolation and must run as a top-level page rather than inside the arcade iframe. It runs on the original publisher site and downloads substantial game assets.</p>'+
    '<p id="state" role="status">Opening the original Portal build in this tab…</p>'+
    '<p><a href="https://alexboops.github.io/portal-1-port/">Launch Portal 1 directly</a> · <a href="../../index.html">Back to Arcade</a></p></main>'+
    '<script>if(window.top===window){window.location.replace("https://alexboops.github.io/portal-1-port/");}else{document.getElementById("state").textContent="Open the game directly in this tab to enable its service worker.";}</script>';
  await fs.writeFile(path.join(folder,"index.html"),portalLanding);
}

// MIT-licensed reVCDOS browser client. The repository does not include the
// commercial game assets; local frontend runs in our player while assets remain
// optional external downloads. No backend-specific Python/PHP routes on Pages.
const revCommit="95f14ef3c1d0a872ecd0881544cc7e1f55cb1946";
const revTemp=await fs.mkdtemp(path.join(os.tmpdir(),"revcdos-"));
try {
  execFileSync("git",["clone","--depth=1","--filter=blob:none",
    "https://github.com/Lolendor/reVCDOS.git",revTemp],
    {stdio:"inherit",timeout:120000});
  const src=path.join(revTemp,"dist");
  const dest=path.join(out,"games","revcdos");
  await fs.mkdir(dest,{recursive:true});
  await fs.cp(src,dest,{recursive:true});
  const htmlFile=path.join(dest,"index.html");
  let html=await fs.readFile(htmlFile,"utf8");
  html=html.replaceAll('src="/intro.mp4"','src="intro.mp4"');
  await fs.writeFile(htmlFile,html);
  // Resolve game-data endpoints directly against the original publisher's CDN.
  // This is not an offline copy of GTA Vice City or a guaranteed CDN integration.
  const gameFile=path.join(dest,"game.js");
  let game=await fs.readFile(gameFile,"utf8");
  game=game.replace('str.replace("https://cdn.dos.zone/vcsky/", "/vcsky/")',
    'str.replace("https://cdn.dos.zone/vcsky/", "https://cdn.dos.zone/vcsky/")');
  game=game.replace('const replaceBR = "/vcbr/"',
    'const replaceBR = "https://br.cdn.dos.zone/vcsky/"');
  await fs.writeFile(gameFile,game);
  await fs.copyFile(path.join(revTemp,"LICENSE"),path.join(dest,"LICENSE"));
  if(!await exists(path.join(dest,"modules","runtime.js")))throw Error("reVCDOS web runtime absent");
  console.log("Bundled reVCDOS MIT web frontend into dist/games/revcdos; game data external.");
} finally {await fs.rm(revTemp,{recursive:true,force:true});}
// Bundle Luigi's Mansion browser port from AlexBoops/lmrip locally.
// Its split RVZ and WebAssembly files are fetched from our Pages path, not
// from the publisher at game runtime. The browser still needs isolation for threads.
const lmCommit="0f81b010940ed40a2c51822b6fc05df7843a743a";
const lmTemp=await fs.mkdtemp(path.join(os.tmpdir(),"lmrip-"));
try {
  execFileSync("git",["clone","--filter=blob:none","--no-checkout",
    "https://github.com/AlexBoops/lmrip.git",lmTemp],
    {stdio:"inherit",timeout:240000});
  execFileSync("git",["-C",lmTemp,"checkout",lmCommit],
    {stdio:"inherit",timeout:240000});
  const dest=path.join(out,"games","lmrip");
  await fs.mkdir(dest,{recursive:true});
  for(const entry of await fs.readdir(lmTemp,{withFileTypes:true})){
    if(entry.name===".git")continue;
    await fs.cp(path.join(lmTemp,entry.name),path.join(dest,entry.name),{recursive:true});
  }
  let html=await fs.readFile(path.join(dest,"index.html"),"utf8");
  // The source includes a Google Docs/about:blank disguise unrelated to the game.
  // Do not carry it into the arcade.
  const cloakMarker=html.indexOf('const abBtn =');
  if(cloakMarker>=0){
    const from=html.lastIndexOf('<script>',cloakMarker);
    const to=html.indexOf('</script>',cloakMarker);
    if(from>=0&&to>from)html=html.slice(0,from)+html.slice(to+9);
  }
  const cloakId=html.indexOf('id="cloak-btn"');
  if(cloakId>=0){
    const from=html.lastIndexOf('<button',cloakId);
    const to=html.indexOf('</button>',cloakId);
    if(from>=0&&to>from)html=html.slice(0,from)+html.slice(to+9);
  }
  // Threaded Dolphin WASM requires crossOriginIsolated. GitHub Pages cannot
  // set COOP/COEP headers directly, so the game's own scoped sw.js must
  // control a TOP-LEVEL page and reload it once after activation.
  // Bound the reload count to prevent an infinite loop when SW is disabled.
  const swStart=html.indexOf("<script>\n  if ('serviceWorker' in navigator)");
  const swEnd=html.indexOf("</script>",swStart);
  if(swStart<0||swEnd<swStart)throw Error("Luigi service worker bootstrap changed");
  const scopedWorkerBootstrap=`<script>
  (() => {
    if (!('serviceWorker' in navigator)) return;
    const reloadKey='seuss-lm-isolation-reload-count';
    if (window.crossOriginIsolated) {
      sessionStorage.removeItem(reloadKey);
      return;
    }
    navigator.serviceWorker.register('./sw.js', {scope:'./'}).then(reg => {
      let reloading=false;
      const reloadWhenReady=() => {
        if(reloading || window.crossOriginIsolated || !reg.active) return;
        const attempts=Number(sessionStorage.getItem(reloadKey)||0);
        if(attempts>=2) {
          console.warn('Luigi isolation still unavailable after worker reloads; check service-worker settings.');
          return;
        }
        reloading=true;
        sessionStorage.setItem(reloadKey,String(attempts+1));
        location.reload();
      };
      if(reg.active) reloadWhenReady();
      navigator.serviceWorker.addEventListener('controllerchange',reloadWhenReady,{once:true});
      reg.addEventListener('updatefound',() => {
        const installing=reg.installing;
        if(installing) installing.addEventListener('statechange',() => {
          if(installing.state==='activated') reloadWhenReady();
        });
      });
    }).catch(err => console.warn('Luigi scoped service worker registration failed:',err));
  })();
  </script>`;
  html=html.slice(0,swStart)+scopedWorkerBootstrap+html.slice(swEnd+"</script>".length);
  // A same-site back link replaces the iframe player's Close button.
  // It works after service-worker reloads and does not redirect to another host.
  if(!html.includes("<body>"))throw Error("Luigi body tag missing");
  html=html.replace("<body>",`<body>
  <style>
    #seuss-arcade-controls{position:fixed;z-index:100000;top:12px;left:12px;
      display:flex;align-items:center;gap:8px;max-width:calc(100vw - 24px)}
    #seuss-arcade-controls a,#seuss-arcade-controls button{
      position:static;display:inline-block;padding:10px 13px;border:1px solid #70b8d2;
      border-radius:9px;background:#10233be8;color:#eaf7ff;text-decoration:none;
      font:700 13px system-ui,sans-serif;box-shadow:0 4px 12px #0008;cursor:pointer}
    #seuss-arcade-controls a:hover,#seuss-arcade-controls button:hover{background:#28496b}
    #seuss-arcade-controls a:focus-visible,#seuss-arcade-controls button:focus-visible{
      outline:3px solid #ffe18a;outline-offset:3px}
  </style>
  <nav id="seuss-arcade-controls" aria-label="Luigi's Mansion controls">
    <a id="seuss-arcade-return" href="../../index.html" aria-label="Back to Seuss Arcade">← Back to Arcade</a>
    <button type="button" id="seuss-arcade-fullscreen" aria-pressed="false" title="Enter fullscreen">⛶ Fullscreen</button>
  </nav>
  <script>
    (() => {
      const button=document.getElementById('seuss-arcade-fullscreen');
      const sync=() => {
        const active=!!document.fullscreenElement;
        button.textContent=active?'⛶ Exit Fullscreen':'⛶ Fullscreen';
        button.setAttribute('aria-pressed',String(active));
        button.title=active?'Exit fullscreen':'Enter fullscreen';
      };
      button.addEventListener('click',async () => {
        try {
          if(document.fullscreenElement)await document.exitFullscreen();
          else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();
          else throw Error('Fullscreen is not supported by this browser.');
        }catch(error){
          console.warn('Luigi fullscreen request failed:',error);
          button.title='Fullscreen unavailable: '+(error.message||String(error));
        }finally{sync();}
      });
      document.addEventListener('fullscreenchange',sync);
    })();
  </script>`);
  await fs.writeFile(path.join(dest,"index.html"),html);
  for(const file of ["lm.js","lm-page.js","lm.data","sw.js","disc.rvz.part0001","disc.rvz.part0008","lm.wasm.part0001","lm.wasm.part0003"]){
    if(!await exists(path.join(dest,file)))throw new Error("Luigi's Mansion bundle missing "+file);
  }
  console.log("Bundled lmrip game files locally into dist/games/lmrip/");
} finally {await fs.rm(lmTemp,{recursive:true,force:true});}
// Bundle Web Dashers as a same-origin local game, using the rights the site owner reports.
// The upstream static site includes third-party art/music; do not mix its files with
// the arcade's root assets. Online-level/account API features may still use upstream servers.
// Pin upstream for reproducible Pages builds; do not run upstream install or build scripts.
const webDashersCommit="84b123b20bca82066350fefe8b49849a24da701c";
const webDashersTemp=await fs.mkdtemp(path.join(os.tmpdir(),"web-dashers-"));
try{
  execFileSync("git",["clone","--depth=1","--filter=blob:none","--no-checkout",
    "https://github.com/web-dashers/web-dashers.github.io.git",webDashersTemp],
    {stdio:"inherit",timeout:240000});
  execFileSync("git",["-C",webDashersTemp,"checkout",webDashersCommit],
    {stdio:"inherit",timeout:240000});
  const gameOut=path.join(out,"games","web-dashers");
  await fs.mkdir(gameOut,{recursive:true});
  for(const entry of ["index.html","assets","README.md"]){
    await fs.cp(path.join(webDashersTemp,entry),path.join(gameOut,entry),{recursive:true});
  }
  for(const file of ["index.html","assets/style.css",
    "assets/scripts/libs/phaser.min.js","assets/scripts/core/main.js",
    "assets/scripts/core/game-scene.js","assets/scripts/game/allLevels.js",
    "assets/scripts/game/allObjects.js","assets/music/Dash.mp3"]){
    const filePath=path.join(gameOut,file);
    if(!await exists(filePath)||(await fs.stat(filePath)).size===0){
      throw new Error("Web Dashers local bundle missing "+file);
    }
  }
  let localIndex=await fs.readFile(path.join(gameOut,"index.html"),"utf8");
  if(!localIndex.includes('src="assets/scripts/core/main.js"')){
    throw new Error("Web Dashers entry point changed; review before shipping");
  }
  console.log("Bundled Web Dashers locally into dist/games/web-dashers from "+webDashersCommit);
} finally {
  await fs.rm(webDashersTemp,{recursive:true,force:true});
}
await fs.writeFile(path.join(out,".nojekyll"),"");
console.log("GitHub Pages build verified.");
