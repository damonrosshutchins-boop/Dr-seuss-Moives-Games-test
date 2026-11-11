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
  /<base\\s+href="https:\\/\\/raw\\.githack\\.com\\/Stratus-Games\\/Hollow-Knight-Webport\\/main\\/"\\s*>/i,
  '<base href="https://cdn.jsdelivr.net/gh/damonrosshutchins-boop/Hollow-Knight-Webport@'+hollowCommit+'/">'
);
if(!hollowHtml.includes("cdn.jsdelivr.net/gh/damonrosshutchins-boop/Hollow-Knight-Webport"))
  throw new Error("Hollow Knight upstream launcher base URL changed");
const hollowOut=path.join(out,"games","hollow-knight");
await fs.mkdir(hollowOut,{recursive:true});
await fs.writeFile(path.join(hollowOut,"index.html"),hollowHtml);
console.log("Bundled Hollow Knight launcher; large split assets remain hosted on user's fork via CDN.");
await fs.writeFile(path.join(out,".nojekyll"),"");
console.log("GitHub Pages build verified.");
