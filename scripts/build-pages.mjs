import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
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
await fs.writeFile(path.join(out,".nojekyll"),"");
console.log("GitHub Pages build verified.");
