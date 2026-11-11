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
for(const file of ["index.html","proxy-client.js","sw.js"])
 await fs.copyFile(file,path.join(out,file));
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
// Large runtimes cannot fit in this Pages artifact. These launch pages keep
// navigation inside the arcade but run the game's existing GitHub Pages build
// in an isolated iframe. They are NOT locally hosted copies of the game assets.
for(const [slug,title,source] of [
  ["minecraft-rust","Minecraft Rust (Web)","https://alexboops.github.io/mc-rust-onweb/"],
  ["half-life-2","Half-Life 2 Web Port","https://alexboops.github.io/half-life-2-port/"],
  ["portal-1","Portal 1 Web Port","https://alexboops.github.io/portal-1-port/"]
]){
  const folder=path.join(out,"games",slug);
  await fs.mkdir(folder,{recursive:true});
  const page='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title>'+
    '<style>html,body{margin:0;height:100%;background:#101522;color:white;font:14px system-ui}iframe{width:100%;height:100%;border:0;display:block}#note{position:absolute;top:0;left:0;right:0;padding:9px;background:#182033d9;pointer-events:none}iframe:not([src]){display:none}</style>'+
    '<div id="note">Source-hosted game running inside the arcade. Browser restrictions may prevent some games from loading.</div>'+
    '<iframe title="'+title+'" referrerpolicy="no-referrer" allow="autoplay; gamepad" src="'+source+'"></iframe></html>';
  await fs.writeFile(path.join(folder,"index.html"),page);
}
await fs.writeFile(path.join(out,".nojekyll"),"");
console.log("GitHub Pages build verified.");
